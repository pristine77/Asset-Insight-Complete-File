import { Request, Response } from "express";
import mongoose from "mongoose";
import AssetReport from "../models/asset.model.js";
import CrmLead, { CRM_LEAD_STATUSES, CRM_LOST_REASONS } from "../models/crmLead.model.js";
import LotListing from "../models/lotListing.model.js";
import User from "../models/user.model.js";
import { productionReportOwnerFilter } from "../service/reviewReportPolicy.js";
import type { ApiKeyRequest } from "../middleware/apiKey.middleware.js";
import { getReportDownloadAccessForGeneration } from "../service/reportReleaseService.js";
import { resolveReportGenerationStateForProfile } from "../utils/reportFileState.js";
import {
  collectPublicApiLotImageSources,
  collectPublicApiReportImageSources,
  encodePublicApiImagePage,
  getPublicApiImagePagination,
  PublicApiImageEncodingError,
  shouldIncludePublicApiImageBase64,
} from "../service/publicApiImagePayloadService.js";

/**
 * Version-stable, API-key-protected read surface for reports, lots, users and CRM.
 *
 * This controller is intentionally an anti-corruption layer over internal Mongo
 * documents: it enforces publication visibility, projects away private fields, and
 * normalizes legacy/current report shapes into contracts external consumers can keep.
 * API-key authentication and rate policy are established by route middleware.
 */

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const RELEASED_REPORT_FILTER = {
  is_draft_preview: { $ne: true },
  // Older approved records predate explicit release_status. Treating absent/null as
  // released preserves historical API visibility while new records use the state field.
  $or: [
    { release_status: "released" },
    { release_status: null },
    { release_status: { $exists: false } },
  ],
};

type PaginationInput = {
  page: number;
  limit: number;
  skip: number;
};

function sendApiError(
  res: Response,
  status: number,
  code: string,
  message: string
) {
  // All public failures use one machine-readable envelope; do not leak raw database
  // errors because external integrations may log or display the response verbatim.
  return res.status(status).json({ error: { code, message } });
}

function sendImageEncodingError(res: Response, error: unknown) {
  if (!(error instanceof PublicApiImageEncodingError)) return false;
  sendApiError(res, 422, "image_encoding_failed", error.message);
  return true;
}

async function optionalReportImagePayload(
  req: Request,
  report: any,
  lots: any[]
) {
  // Base64 expansion is expensive in memory and bandwidth, so it is opt-in and paged.
  // Dedicated image endpoints remain preferable for clients walking a full gallery.
  if (!shouldIncludePublicApiImageBase64(req.query.includeImageBase64)) {
    return null;
  }
  const { page, limit } = getPublicApiImagePagination(
    req.query as Record<string, unknown>,
    { prefix: "image" }
  );
  return encodePublicApiImagePage(
    collectPublicApiReportImageSources(report, lots),
    page,
    limit
  );
}

async function optionalLotImagePayload(
  req: Request,
  report: any,
  lot: any,
  lotIndex: number
) {
  if (!shouldIncludePublicApiImageBase64(req.query.includeImageBase64)) {
    return null;
  }
  const { page, limit } = getPublicApiImagePagination(
    req.query as Record<string, unknown>,
    { prefix: "image" }
  );
  return encodePublicApiImagePage(
    collectPublicApiLotImageSources(report, lot, lotIndex),
    page,
    limit
  );
}

function getPagination(req: Request): PaginationInput {
  // Clamp caller input to protect the public boundary from unbounded collection reads.
  const page = Math.max(parseInt(String(req.query.page || "1"), 10) || 1, 1);
  const rawLimit = parseInt(String(req.query.limit || DEFAULT_LIMIT), 10);
  const limit = Math.min(Math.max(rawLimit || DEFAULT_LIMIT, 1), MAX_LIMIT);
  return { page, limit, skip: (page - 1) * limit };
}

function paginationMeta(total: number, page: number, limit: number) {
  return {
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit),
  };
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function makeRegex(value: unknown) {
  // Public search is literal substring matching; escaping prevents callers from
  // supplying arbitrary regular expressions with surprising cost or semantics.
  const text = typeof value === "string" ? value.trim() : "";
  return text ? new RegExp(escapeRegExp(text), "i") : null;
}

function parseDate(value: unknown, endOfDay = false) {
  if (typeof value !== "string" || !value.trim()) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  if (endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
    date.setHours(23, 59, 59, 999);
  }
  return date;
}

function applyDateFilters(filter: Record<string, any>, req: Request) {
  const from = parseDate(req.query.from);
  const to = parseDate(req.query.to, true);
  if (from || to) {
    filter.createdAt = {};
    if (from) filter.createdAt.$gte = from;
    if (to) filter.createdAt.$lte = to;
  }

  const updatedAfter = parseDate(req.query.updatedAfter);
  if (updatedAfter) {
    filter.updatedAt = { $gte: updatedAfter };
  }
}

async function buildAssetFilter(
  req: Request,
  options: { includeQ?: boolean } = {}
) {
  const filter: Record<string, any> = {
    status: "approved",
    ...RELEASED_REPORT_FILTER,
    ...await productionReportOwnerFilter(),
  };
  const clauses: any[] = [];
  applyDateFilters(filter, req);

  const q = options.includeQ === false ? null : makeRegex(req.query.q);
  if (q) {
    clauses.push({
      $or: [
        { client_name: q },
        { prepared_for: q },
        { contract_no: q },
        { "preview_data.client_name": q },
        { "preview_data.prepared_for": q },
        { "preview_data.contract_no": q },
        { "lots.title": q },
        { "lots.description": q },
      ],
    });
  }

  const contractNo = makeRegex(req.query.contractNo);
  if (contractNo) {
    clauses.push({
      $or: [{ contract_no: contractNo }, { "preview_data.contract_no": contractNo }],
    });
  }

  if (clauses.length > 0) filter.$and = clauses;
  return filter;
}

async function buildLotListingFilter(
  req: Request,
  options: { includeQ?: boolean } = {}
) {
  const filter: Record<string, any> = {
    status: "approved",
    ...RELEASED_REPORT_FILTER,
    ...await productionReportOwnerFilter(),
  };
  const clauses: any[] = [];
  applyDateFilters(filter, req);

  const q = options.includeQ === false ? null : makeRegex(req.query.q);
  if (q) {
    clauses.push({
      $or: [
        { contract_no: q },
        { location: q },
        { "preview_data.contract_no": q },
        { "preview_data.location": q },
        { "lots.title": q },
        { "lots.description": q },
        { "lots.serial_number": q },
      ],
    });
  }

  const contractNo = makeRegex(req.query.contractNo);
  if (contractNo) {
    clauses.push({
      $or: [{ contract_no: contractNo }, { "preview_data.contract_no": contractNo }],
    });
  }

  if (clauses.length > 0) filter.$and = clauses;
  return filter;
}

function safeCreator(user: any) {
  if (!user || typeof user !== "object") return null;
  return {
    _id: String(user._id || ""),
    email: user.email || undefined,
    username: user.username || undefined,
    companyName: user.companyName || undefined,
  };
}

function serializeAssignableUser(user: any) {
  const username =
    typeof user?.username === "string" && user.username.trim()
      ? user.username.trim()
      : null;
  const companyName =
    typeof user?.companyName === "string" && user.companyName.trim()
      ? user.companyName.trim()
      : null;
  const email =
    typeof user?.email === "string" && user.email.trim()
      ? user.email.trim()
      : "";
  return {
    _id: String(user?._id || ""),
    displayName: username || companyName || email,
    username,
    email,
    companyName,
    role: "user" as const,
    updatedAt: user?.updatedAt,
  };
}

function getAssetLots(report: any) {
  // Once preview edits exist they are the published representation. Falling back to
  // source lots keeps pre-preview records compatible with the same API contract.
  const previewLots = report?.preview_data?.lots;
  if (Array.isArray(previewLots) && previewLots.length > 0) return previewLots;
  return Array.isArray(report?.lots) ? report.lots : [];
}

function getLotListingLots(listing: any) {
  const previewLots = listing?.preview_data?.lots;
  if (Array.isArray(previewLots) && previewLots.length > 0) return previewLots;
  return Array.isArray(listing?.lots) ? listing.lots : [];
}

function getAssetTitle(report: any) {
  return (
    report?.preview_data?.client_name ||
    report?.client_name ||
    report?.preview_data?.prepared_for ||
    report?.prepared_for ||
    "Asset Report"
  );
}

function serializeAssetSummary(report: any) {
  const lots = getAssetLots(report);
  const previewData = report.preview_data || {};
  const generation = resolveReportGenerationStateForProfile(
    "asset",
    report,
    report.preview_files,
    report.files
  );
  // Generation state alone is insufficient: release policy decides whether artifact
  // locations may be exposed. Disallowed reports receive an empty `files` object.
  const downloadAccess = getReportDownloadAccessForGeneration(
    report,
    generation
  );
  return {
    _id: String(report._id),
    type: "asset",
    title: getAssetTitle(report),
    status: report.status,
    grouping_mode: report.grouping_mode,
    contract_no: previewData.contract_no || report.contract_no || null,
    currency: previewData.currency || report.currency || "CAD",
    language: report.language || "en",
    lot_count: lots.length,
    image_count: Array.isArray(report.imageUrls) ? report.imageUrls.length : 0,
    total_value:
      previewData?.valuation_data?.baseFMV ??
      previewData?.total_value ??
      previewData?.total_appraised_value ??
      null,
    downloadable: downloadAccess.allowed,
    download_access: downloadAccess,
    ...generation,
    files: downloadAccess.allowed ? report.preview_files || {} : {},
    createdAt: report.createdAt,
    updatedAt: report.updatedAt,
    creator: safeCreator(report.user),
  };
}

function serializeAssetDetail(report: any) {
  const summary = serializeAssetSummary(report);
  return {
    ...summary,
    metadata: {
      client_name: report.client_name,
      prepared_for: report.prepared_for,
      owner_name: report.owner_name,
      appraisal_purpose: report.appraisal_purpose,
      appraisal_company: report.appraisal_company,
      appraiser: report.appraiser,
      industry: report.industry,
      effective_date: report.effective_date,
      inspection_date: report.inspection_date,
      contract_no: report.contract_no,
    },
    imageUrls: report.imageUrls || [],
    lots: getAssetLots(report),
    originalLots: Array.isArray(report.lots) ? report.lots : [],
    preview_data: report.preview_data || null,
    preview_files: summary.downloadable ? report.preview_files || {} : {},
    valuation_data: report.valuation_data || null,
    analysis: report.analysis || null,
  };
}

function serializeLotListingSummary(listing: any) {
  const lots = getLotListingLots(listing);
  const previewData = listing.preview_data || {};
  const generation = resolveReportGenerationStateForProfile(
    "lotListing",
    listing,
    listing.preview_files,
    listing.files
  );
  const downloadAccess = getReportDownloadAccessForGeneration(
    listing,
    generation
  );
  return {
    _id: String(listing._id),
    type: "lot-listing",
    title: previewData.contract_no || listing.contract_no || "Lot Listing",
    status: listing.status,
    contract_no: previewData.contract_no || listing.contract_no || null,
    location: previewData.location || listing.location || null,
    sales_date: previewData.sales_date || listing.sales_date || null,
    currency: previewData.currency || listing.currency || "CAD",
    language: listing.language || "en",
    lot_count: lots.length,
    image_count: Array.isArray(listing.imageUrls) ? listing.imageUrls.length : 0,
    total_value: previewData.total_value ?? listing.total_value ?? null,
    downloadable: downloadAccess.allowed,
    download_access: downloadAccess,
    ...generation,
    files: downloadAccess.allowed
      ? listing.files || listing.preview_files || {}
      : {},
    createdAt: listing.createdAt,
    updatedAt: listing.updatedAt,
    creator: safeCreator(listing.user),
  };
}

function serializeLotListingDetail(listing: any) {
  const summary = serializeLotListingSummary(listing);
  return {
    ...summary,
    metadata: {
      contract_no: listing.contract_no,
      sales_date: listing.sales_date,
      location: listing.location,
      mixed_lots: listing.mixed_lots || [],
      total_value: listing.total_value,
    },
    imageUrls: listing.imageUrls || [],
    lots: getLotListingLots(listing),
    originalLots: Array.isArray(listing.lots) ? listing.lots : [],
    preview_data: listing.preview_data || null,
    preview_files: summary.downloadable ? listing.preview_files || {} : {},
    files: summary.downloadable ? listing.files || {} : {},
    analysis: listing.analysis || null,
  };
}

function safeUser(user: any) {
  if (!user || typeof user !== "object") return null;
  return {
    _id: String(user._id || ""),
    email: user.email || undefined,
    username: user.username || undefined,
    companyName: user.companyName || undefined,
  };
}

function serializeCrmUpdate(update: any) {
  // CRM updates are soft-deleted internally for auditability but must disappear from
  // the external lead timeline.
  if (!update || update.isDeleted) return null;
  return {
    _id: String(update._id || ""),
    comment: update.comment || "",
    status: update.status || null,
    lostReason: update.lostReason || null,
    reminderDate: update.reminderDate || null,
    attachmentUrls: Array.isArray(update.attachmentUrls) ? update.attachmentUrls : [],
    recordingUrl: update.recordingUrl || null,
    createdBy: safeUser(update.createdBy),
    createdAt: update.createdAt || null,
  };
}

function serializeCrmLead(lead: any) {
  const updates = Array.isArray(lead.updates)
    ? lead.updates.map(serializeCrmUpdate).filter(Boolean)
    : [];
  return {
    _id: String(lead._id || ""),
    title: lead.title || "CRM Follow-up",
    clientName: lead.clientName,
    companyName: lead.companyName || null,
    email: lead.email || null,
    phoneFormatted: lead.phoneFormatted || null,
    contactLocation: lead.contactLocation || null,
    companyLocation: lead.companyLocation || null,
    category: lead.category || null,
    specialization: lead.specialization || null,
    status: lead.status,
    lostReason: lead.lostReason || null,
    priority: lead.priority,
    dueDate: lead.dueDate || null,
    latestComment: lead.latestComment || null,
    assignedTo: safeUser(lead.assignedTo),
    assignedBy: safeUser(lead.assignedBy),
    updates,
    createdAt: lead.createdAt,
    updatedAt: lead.updatedAt,
  };
}

function findLot(lots: any[], lotId: string) {
  // Both identifiers are supported because the two report pipelines historically
  // persisted different lot keys and external clients may retain either form.
  return lots.find((lot) => {
    return (
      String(lot?.lot_id || "") === lotId ||
      String(lot?.lot_number || "") === lotId
    );
  });
}

function lotMatchesQuery(lot: any, reportSummary: any, q: RegExp | null) {
  if (!q) return true;
  const fields = [
    lot?.lot_id,
    lot?.lot_number,
    lot?.title,
    lot?.description,
    lot?.details,
    lot?.categories,
    lot?.location,
    lot?.item_condition,
    lot?.serial_number,
    lot?.serial_no_or_label,
    reportSummary?.title,
    reportSummary?.contract_no,
    reportSummary?.location,
  ];
  return fields.some((field) => typeof field === "string" && q.test(field));
}

export const listAssets = async (req: Request, res: Response) => {
  try {
    const { page, limit, skip } = getPagination(req);
    const filter = await buildAssetFilter(req);
    // Data and count share the exact visibility filter; running them concurrently
    // reduces latency while retaining the established pagination metadata.
    const [items, total] = await Promise.all([
      AssetReport.find(filter)
        .populate("user", "email username companyName")
        .select(
          "_id user status grouping_mode client_name prepared_for contract_no language currency preview_data.client_name preview_data.prepared_for preview_data.contract_no preview_data.currency preview_data.total_value preview_data.total_appraised_value preview_data.valuation_data preview_files files job_status job_error files_generating files_regenerating generation_target_status generation_progress imageUrls lots.lot_id lots.lot_number createdAt updatedAt"
        )
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      AssetReport.countDocuments(filter),
    ]);

    return res.status(200).json({
      data: items.map(serializeAssetSummary),
      pagination: paginationMeta(total, page, limit),
    });
  } catch (error) {
    console.error("listAssets API error", error);
    return sendApiError(res, 500, "server_error", "Failed to fetch assets");
  }
};

export const listUsers = async (req: Request, res: Response) => {
  try {
    const { page, limit, skip } = getPagination(req);
    // This is an assignment directory, not a user-administration endpoint. Only active,
    // verified ordinary users and an explicit safe projection cross the API boundary.
    const filter: Record<string, any> = {
      role: "user",
      isVerified: true,
      isBlocked: { $ne: true },
      isReviewAccount: { $ne: true },
    };
    const q = makeRegex(req.query.q);
    if (q) {
      filter.$or = [{ username: q }, { email: q }, { companyName: q }];
    }
    const updatedAfter = parseDate(req.query.updatedAfter);
    if (updatedAfter) {
      filter.updatedAt = { $gte: updatedAfter };
    }

    const [users, total] = await Promise.all([
      User.find(filter)
        .select("_id username email companyName role updatedAt")
        .sort({ username: 1, email: 1, _id: 1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      User.countDocuments(filter),
    ]);

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      data: users.map(serializeAssignableUser),
      pagination: paginationMeta(total, page, limit),
    });
  } catch (error) {
    console.error("listUsers API error", error);
    return sendApiError(res, 500, "server_error", "Failed to fetch users");
  }
};

export const getAsset = async (req: Request, res: Response) => {
  try {
    // Invalid and inaccessible ids intentionally share the same 404 contract, avoiding
    // Mongo cast failures and preventing callers from inferring unpublished records.
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return sendApiError(res, 404, "not_found", "Asset not found");
    }

    const report = await AssetReport.findOne({
      _id: req.params.id,
      status: "approved",
      ...RELEASED_REPORT_FILTER,
      ...await productionReportOwnerFilter(),
    })
      .populate("user", "email username companyName")
      .lean();

    if (!report) {
      return sendApiError(res, 404, "not_found", "Asset not found");
    }

    const imagePayload = await optionalReportImagePayload(
      req,
      report,
      getAssetLots(report)
    );
    if (imagePayload) res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      data: {
        ...serializeAssetDetail(report),
        ...(imagePayload
          ? {
              image_payloads: imagePayload.data,
              image_payload_pagination: imagePayload.pagination,
            }
          : {}),
      },
    });
  } catch (error) {
    if (sendImageEncodingError(res, error)) return;
    console.error("getAsset API error", error);
    return sendApiError(res, 500, "server_error", "Failed to fetch asset");
  }
};

export const getAssetImages = async (req: Request, res: Response) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return sendApiError(res, 404, "not_found", "Asset not found");
    }
    const report = await AssetReport.findOne({
      _id: req.params.id,
      status: "approved",
      ...RELEASED_REPORT_FILTER,
      ...await productionReportOwnerFilter(),
    })
      .populate("user", "email username companyName")
      .lean();
    if (!report) {
      return sendApiError(res, 404, "not_found", "Asset not found");
    }

    const { page, limit } = getPublicApiImagePagination(
      req.query as Record<string, unknown>
    );
    const payload = await encodePublicApiImagePage(
      collectPublicApiReportImageSources(report, getAssetLots(report)),
      page,
      limit
    );
    // Encoded image bodies can contain sensitive visual data and are intentionally not
    // cached by intermediary or browser caches.
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      ...payload,
      report: serializeAssetSummary(report),
    });
  } catch (error) {
    if (sendImageEncodingError(res, error)) return;
    console.error("getAssetImages API error", error);
    return sendApiError(res, 500, "server_error", "Failed to fetch asset images");
  }
};

export const listAssetLots = async (req: Request, res: Response) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return sendApiError(res, 404, "not_found", "Asset not found");
    }

    const report = await AssetReport.findOne({
      _id: req.params.id,
      status: "approved",
      ...RELEASED_REPORT_FILTER,
      ...await productionReportOwnerFilter(),
    })
      .populate("user", "email username companyName")
      .lean();

    if (!report) {
      return sendApiError(res, 404, "not_found", "Asset not found");
    }

    return res.status(200).json({
      data: getAssetLots(report),
      report: serializeAssetSummary(report),
    });
  } catch (error) {
    console.error("listAssetLots API error", error);
    return sendApiError(res, 500, "server_error", "Failed to fetch asset lots");
  }
};

export const getAssetLot = async (req: Request, res: Response) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return sendApiError(res, 404, "not_found", "Asset not found");
    }

    const report = await AssetReport.findOne({
      _id: req.params.id,
      status: "approved",
      ...RELEASED_REPORT_FILTER,
      ...await productionReportOwnerFilter(),
    })
      .populate("user", "email username companyName")
      .lean();

    if (!report) {
      return sendApiError(res, 404, "not_found", "Asset not found");
    }

    const lots = getAssetLots(report);
    const lot = findLot(lots, req.params.lotId);
    if (!lot) {
      return sendApiError(res, 404, "not_found", "Asset lot not found");
    }

    const imagePayload = await optionalLotImagePayload(
      req,
      report,
      lot,
      lots.indexOf(lot)
    );
    if (imagePayload) res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      data: {
        ...lot,
        ...(imagePayload
          ? {
              image_payloads: imagePayload.data,
              image_payload_pagination: imagePayload.pagination,
            }
          : {}),
      },
      report: serializeAssetSummary(report),
    });
  } catch (error) {
    if (sendImageEncodingError(res, error)) return;
    console.error("getAssetLot API error", error);
    return sendApiError(res, 500, "server_error", "Failed to fetch asset lot");
  }
};

export const getAssetLotImages = async (req: Request, res: Response) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return sendApiError(res, 404, "not_found", "Asset not found");
    }
    const report = await AssetReport.findOne({
      _id: req.params.id,
      status: "approved",
      ...RELEASED_REPORT_FILTER,
      ...await productionReportOwnerFilter(),
    })
      .populate("user", "email username companyName")
      .lean();
    if (!report) {
      return sendApiError(res, 404, "not_found", "Asset not found");
    }
    const lots = getAssetLots(report);
    const lot = findLot(lots, req.params.lotId);
    if (!lot) {
      return sendApiError(res, 404, "not_found", "Asset lot not found");
    }

    const { page, limit } = getPublicApiImagePagination(
      req.query as Record<string, unknown>
    );
    const payload = await encodePublicApiImagePage(
      collectPublicApiLotImageSources(report, lot, lots.indexOf(lot)),
      page,
      limit
    );
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      ...payload,
      report: serializeAssetSummary(report),
      lot: {
        lot_id: lot?.lot_id || null,
        lot_number: lot?.lot_number || null,
        title: lot?.title || null,
      },
    });
  } catch (error) {
    if (sendImageEncodingError(res, error)) return;
    console.error("getAssetLotImages API error", error);
    return sendApiError(res, 500, "server_error", "Failed to fetch asset lot images");
  }
};

export const listLotListings = async (req: Request, res: Response) => {
  try {
    const { page, limit, skip } = getPagination(req);
    const filter = await buildLotListingFilter(req);
    const [items, total] = await Promise.all([
      LotListing.find(filter)
        .populate("user", "email username companyName")
        .select(
          "_id user status contract_no sales_date location language currency preview_data.contract_no preview_data.location preview_data.sales_date preview_data.currency preview_data.total_value preview_files files job_status job_error files_generating files_regenerating generation_target_status generation_progress imageUrls lots.lot_id lots.lot_number total_value createdAt updatedAt"
        )
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      LotListing.countDocuments(filter),
    ]);

    return res.status(200).json({
      data: items.map(serializeLotListingSummary),
      pagination: paginationMeta(total, page, limit),
    });
  } catch (error) {
    console.error("listLotListings API error", error);
    return sendApiError(
      res,
      500,
      "server_error",
      "Failed to fetch lot listings"
    );
  }
};

export const getLotListing = async (req: Request, res: Response) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return sendApiError(res, 404, "not_found", "Lot listing not found");
    }

    const listing = await LotListing.findOne({
      _id: req.params.id,
      status: "approved",
      ...RELEASED_REPORT_FILTER,
      ...await productionReportOwnerFilter(),
    })
      .populate("user", "email username companyName")
      .lean();

    if (!listing) {
      return sendApiError(res, 404, "not_found", "Lot listing not found");
    }

    const imagePayload = await optionalReportImagePayload(
      req,
      listing,
      getLotListingLots(listing)
    );
    if (imagePayload) res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      data: {
        ...serializeLotListingDetail(listing),
        ...(imagePayload
          ? {
              image_payloads: imagePayload.data,
              image_payload_pagination: imagePayload.pagination,
            }
          : {}),
      },
    });
  } catch (error) {
    if (sendImageEncodingError(res, error)) return;
    console.error("getLotListing API error", error);
    return sendApiError(
      res,
      500,
      "server_error",
      "Failed to fetch lot listing"
    );
  }
};

export const getLotListingImages = async (req: Request, res: Response) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return sendApiError(res, 404, "not_found", "Lot listing not found");
    }
    const listing = await LotListing.findOne({
      _id: req.params.id,
      status: "approved",
      ...RELEASED_REPORT_FILTER,
      ...await productionReportOwnerFilter(),
    })
      .populate("user", "email username companyName")
      .lean();
    if (!listing) {
      return sendApiError(res, 404, "not_found", "Lot listing not found");
    }

    const { page, limit } = getPublicApiImagePagination(
      req.query as Record<string, unknown>
    );
    const payload = await encodePublicApiImagePage(
      collectPublicApiReportImageSources(listing, getLotListingLots(listing)),
      page,
      limit
    );
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      ...payload,
      report: serializeLotListingSummary(listing),
    });
  } catch (error) {
    if (sendImageEncodingError(res, error)) return;
    console.error("getLotListingImages API error", error);
    return sendApiError(
      res,
      500,
      "server_error",
      "Failed to fetch lot listing images"
    );
  }
};

export const listLotListingLots = async (req: Request, res: Response) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return sendApiError(res, 404, "not_found", "Lot listing not found");
    }

    const listing = await LotListing.findOne({
      _id: req.params.id,
      status: "approved",
      ...RELEASED_REPORT_FILTER,
      ...await productionReportOwnerFilter(),
    })
      .populate("user", "email username companyName")
      .lean();

    if (!listing) {
      return sendApiError(res, 404, "not_found", "Lot listing not found");
    }

    return res.status(200).json({
      data: getLotListingLots(listing),
      report: serializeLotListingSummary(listing),
    });
  } catch (error) {
    console.error("listLotListingLots API error", error);
    return sendApiError(
      res,
      500,
      "server_error",
      "Failed to fetch lot listing lots"
    );
  }
};

export const getLotListingLot = async (req: Request, res: Response) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return sendApiError(res, 404, "not_found", "Lot listing not found");
    }

    const listing = await LotListing.findOne({
      _id: req.params.id,
      status: "approved",
      ...RELEASED_REPORT_FILTER,
      ...await productionReportOwnerFilter(),
    })
      .populate("user", "email username companyName")
      .lean();

    if (!listing) {
      return sendApiError(res, 404, "not_found", "Lot listing not found");
    }

    const lots = getLotListingLots(listing);
    const lot = findLot(lots, req.params.lotId);
    if (!lot) {
      return sendApiError(res, 404, "not_found", "Lot listing lot not found");
    }

    const imagePayload = await optionalLotImagePayload(
      req,
      listing,
      lot,
      lots.indexOf(lot)
    );
    if (imagePayload) res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      data: {
        ...lot,
        ...(imagePayload
          ? {
              image_payloads: imagePayload.data,
              image_payload_pagination: imagePayload.pagination,
            }
          : {}),
      },
      report: serializeLotListingSummary(listing),
    });
  } catch (error) {
    if (sendImageEncodingError(res, error)) return;
    console.error("getLotListingLot API error", error);
    return sendApiError(
      res,
      500,
      "server_error",
      "Failed to fetch lot listing lot"
    );
  }
};

export const getLotListingLotImages = async (req: Request, res: Response) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return sendApiError(res, 404, "not_found", "Lot listing not found");
    }
    const listing = await LotListing.findOne({
      _id: req.params.id,
      status: "approved",
      ...RELEASED_REPORT_FILTER,
      ...await productionReportOwnerFilter(),
    })
      .populate("user", "email username companyName")
      .lean();
    if (!listing) {
      return sendApiError(res, 404, "not_found", "Lot listing not found");
    }
    const lots = getLotListingLots(listing);
    const lot = findLot(lots, req.params.lotId);
    if (!lot) {
      return sendApiError(res, 404, "not_found", "Lot listing lot not found");
    }

    const { page, limit } = getPublicApiImagePagination(
      req.query as Record<string, unknown>
    );
    const payload = await encodePublicApiImagePage(
      collectPublicApiLotImageSources(listing, lot, lots.indexOf(lot)),
      page,
      limit
    );
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      ...payload,
      report: serializeLotListingSummary(listing),
      lot: {
        lot_id: lot?.lot_id || null,
        lot_number: lot?.lot_number || null,
        title: lot?.title || null,
      },
    });
  } catch (error) {
    if (sendImageEncodingError(res, error)) return;
    console.error("getLotListingLotImages API error", error);
    return sendApiError(
      res,
      500,
      "server_error",
      "Failed to fetch lot listing lot images"
    );
  }
};

export const listCrmLeads = async (req: Request, res: Response) => {
  try {
    const { page, limit, skip } = getPagination(req);
    const filter: Record<string, any> = { isReviewData: { $ne: true } };
    const q = makeRegex(req.query.q);
    const status = typeof req.query.status === "string" ? req.query.status : "";

    if (status && CRM_LEAD_STATUSES.includes(status as any)) {
      filter.status = status;
    }

    if (q) {
      filter.$or = [
        { title: q },
        { clientName: q },
        { companyName: q },
        { email: q },
        { phoneFormatted: q },
        { notes: q },
        { category: q },
        { specialization: q },
      ];
    }

    const updatedAfter = parseDate(req.query.updatedAfter);
    if (updatedAfter) filter.updatedAt = { $gte: updatedAfter };

    const [items, total] = await Promise.all([
      CrmLead.find(filter)
        .populate("assignedTo", "email username companyName")
        .populate("assignedBy", "email username companyName")
        .populate("updates.createdBy", "email username companyName")
        .sort({ updatedAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      CrmLead.countDocuments(filter),
    ]);

    return res.status(200).json({
      data: items.map(serializeCrmLead),
      pagination: paginationMeta(total, page, limit),
    });
  } catch (error) {
    console.error("listCrmLeads API error", error);
    return sendApiError(res, 500, "server_error", "Failed to fetch CRM leads");
  }
};

export const getCrmLead = async (req: Request, res: Response) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return sendApiError(res, 404, "not_found", "CRM lead not found");
    }

    const lead = await CrmLead.findOne({ _id: req.params.id, isReviewData: { $ne: true } })
      .populate("assignedTo", "email username companyName")
      .populate("assignedBy", "email username companyName")
      .populate("updates.createdBy", "email username companyName")
      .lean();

    if (!lead) {
      return sendApiError(res, 404, "not_found", "CRM lead not found");
    }

    return res.status(200).json({ data: serializeCrmLead(lead) });
  } catch (error) {
    console.error("getCrmLead API error", error);
    return sendApiError(res, 500, "server_error", "Failed to fetch CRM lead");
  }
};

export const replyToCrmLead = async (req: ApiKeyRequest, res: Response) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return sendApiError(res, 404, "not_found", "CRM lead not found");
    }

    // Replies are attributed to the user linked to the API key, never to a user id
    // supplied in the request body.
    const createdBy = req.apiKey?.createdBy || "";
    if (!mongoose.Types.ObjectId.isValid(createdBy)) {
      return sendApiError(res, 403, "not_authorized", "API key is not linked to an authorized user");
    }

    const comment = typeof req.body?.comment === "string" ? req.body.comment.trim() : "";
    const nextStatus = typeof req.body?.status === "string" ? req.body.status : "";
    const lostReason = typeof req.body?.lostReason === "string" ? req.body.lostReason : "";

    if (!comment) {
      return sendApiError(res, 400, "invalid_comment", "comment is required");
    }
    if (nextStatus && !CRM_LEAD_STATUSES.includes(nextStatus as any)) {
      return sendApiError(res, 400, "invalid_status", "status is invalid");
    }
    if (lostReason && !CRM_LOST_REASONS.includes(lostReason as any)) {
      return sendApiError(res, 400, "invalid_lost_reason", "lostReason is invalid");
    }

    const lead = await CrmLead.findOne({ _id: req.params.id, isReviewData: { $ne: true } });
    if (!lead) {
      return sendApiError(res, 404, "not_found", "CRM lead not found");
    }

    // Every timeline entry snapshots the effective status. Lost-reason data is kept
    // only while that status is `lost`, preventing stale reasons after recovery.
    const statusToStore = nextStatus || (lead as any).status || "new_lead";
    (lead as any).updates.push({
      comment,
      status: statusToStore,
      lostReason: statusToStore === "lost" ? lostReason || undefined : undefined,
      createdBy: new mongoose.Types.ObjectId(createdBy),
      createdAt: new Date(),
    });
    (lead as any).latestComment = comment;
    if (nextStatus) {
      (lead as any).status = nextStatus;
      (lead as any).statusChangedAt = new Date();
      (lead as any).lostReason = nextStatus === "lost" ? lostReason || undefined : undefined;
    }

    await lead.save();

    const saved = await CrmLead.findById(lead._id)
      .populate("assignedTo", "email username companyName")
      .populate("assignedBy", "email username companyName")
      .populate("updates.createdBy", "email username companyName")
      .lean();

    return res.status(200).json({ data: serializeCrmLead(saved) });
  } catch (error) {
    console.error("replyToCrmLead API error", error);
    return sendApiError(res, 500, "server_error", "Failed to reply to CRM lead");
  }
};

export const listLots = async (req: Request, res: Response) => {
  try {
    const source = typeof req.query.source === "string" ? req.query.source : "";
    if (source && source !== "asset" && source !== "lot-listing") {
      return sendApiError(
        res,
        400,
        "invalid_source",
        "source must be asset or lot-listing"
      );
    }

    const { page, limit, skip } = getPagination(req);
    const q = makeRegex(req.query.q);
    // Lots are embedded in two different report collections. They are flattened and
    // merged before slicing so pagination and ordering apply to one logical result set.
    const rows: any[] = [];

    if (!source || source === "asset") {
      const assets = await AssetReport.find(await buildAssetFilter(req, { includeQ: false }))
        .populate("user", "email username companyName")
        .select(
          "_id user status grouping_mode client_name prepared_for contract_no language currency preview_data preview_files files job_status job_error files_generating files_regenerating generation_target_status generation_progress imageUrls lots createdAt updatedAt"
        )
        .sort({ createdAt: -1 })
        .lean();

      for (const report of assets) {
        const summary = serializeAssetSummary(report);
        for (const lot of getAssetLots(report)) {
          if (!lotMatchesQuery(lot, summary, q)) continue;
          rows.push({
            source: "asset",
            reportId: String(report._id),
            report: summary,
            lot,
          });
        }
      }
    }

    if (!source || source === "lot-listing") {
      const listings = await LotListing.find(await buildLotListingFilter(req, { includeQ: false }))
        .populate("user", "email username companyName")
        .select(
          "_id user status contract_no sales_date location language currency preview_data preview_files files job_status job_error files_generating files_regenerating generation_target_status generation_progress imageUrls lots mixed_lots total_value createdAt updatedAt"
        )
        .sort({ createdAt: -1 })
        .lean();

      for (const listing of listings) {
        const summary = serializeLotListingSummary(listing);
        for (const lot of getLotListingLots(listing)) {
          if (!lotMatchesQuery(lot, summary, q)) continue;
          rows.push({
            source: "lot-listing",
            reportId: String(listing._id),
            report: summary,
            lot,
          });
        }
      }
    }

    rows.sort((a, b) => {
      return (
        new Date(b.report.createdAt).getTime() -
        new Date(a.report.createdAt).getTime()
      );
    });

    return res.status(200).json({
      data: rows.slice(skip, skip + limit),
      pagination: paginationMeta(rows.length, page, limit),
    });
  } catch (error) {
    console.error("listLots API error", error);
    return sendApiError(res, 500, "server_error", "Failed to fetch lots");
  }
};
