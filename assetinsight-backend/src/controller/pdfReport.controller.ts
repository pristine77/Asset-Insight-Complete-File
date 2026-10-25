/**
 * Report artifact read, download, regeneration and deletion controller.
 *
 * Stored report metadata is resolved into stable file responses while download policy
 * is evaluated from workflow and generation state. Streaming paths, filenames and
 * legacy aliases are kept at this boundary so storage internals can evolve without
 * changing client-visible contracts.
 */
import { Request, Response } from "express";
import { productionReportOwnerFilter } from "../service/reviewReportPolicy.js";
import axios from "axios";
import PdfReport from "../models/pdfReport.model.js";
import AssetReport from "../models/asset.model.js";
import LotListing from "../models/lotListing.model.js";
import fs from "fs/promises";
import path from "path";
import { pipeline } from "node:stream/promises";
import { getR2ObjectStream, isR2ObjectNotFoundError, resolveR2ObjectLocationFromUrl } from "../utils/r2Storage/r2Upload.js";
import type { AuthRequest } from "../middleware/auth.middleware.js";
import {
  getReportPreviewPayloadById,
  saveAssetAdminScheduleSheetById,
} from "../service/reportPreviewService.js";
import {
  buildSpecReportData,
  resolveCrDocxAccessById,
  resolveCrPdfAccessById,
} from "../service/auctioneerSpecPdfRefreshService.js";
import { queueAssetScheduleSheetRegeneration } from "../service/assetScheduleSheetRegenerationService.js";
import {
  proposalValuationErrorBody,
  ProposalValuationError,
} from "../service/proposalValuationService.js";
import {
  buildReportArtifactFilenames,
  getReportLots,
} from "../utils/reportArtifactNames.js";
import {
  CR_DISCLAIMER_OPTIONS,
  countActiveCrDisclaimers,
  countLotsWithCrDisclaimers,
  getCrDisclaimerLotKey,
  getCrDisclaimersForLot,
  normalizeCrDisclaimers,
} from "../utils/crDisclaimers.js";
import {
  getReportDownloadAccess,
  getReportDownloadAccessForGeneration,
  releaseStatusForPayload,
  assertCurrentSalvagePdfArtifact,
  assertLegacyPdfReportGroupFilesReady,
  filterCurrentPdfReportArtifacts,
} from "../service/reportReleaseService.js";
import { resolveReportGenerationStateForProfile } from "../utils/reportFileState.js";
import {
  ExcelConditionReportError,
  saveExcelConditionReports,
} from "../service/excelConditionReportService.js";
import { queueExcelCrRegenerationJob } from "../jobs/excelCrRegenerationJob.js";
import { proposalValuationWritableRevisionCondition } from "../service/proposalValuationArtifactPublicationService.js";

const CR_DOCX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

async function resolveAssetOrLotListingTarget(id: string): Promise<
  | { kind: "asset"; doc: any; parentId: string }
  | { kind: "lotListing"; doc: any; parentId: string }
  | null
> {
  const pdfReport = await PdfReport.findById(id).lean().catch(() => null);
  const parentId = String((pdfReport as any)?.report || id);

  const asset = await AssetReport.findOne({
    _id: parentId,
    is_draft_preview: { $ne: true },
  })
    .populate("user", "email username name companyName")
    .catch(() => null);
  if (asset) return { kind: "asset", doc: asset, parentId: String(asset._id) };

  const listing = await LotListing.findOne({
    _id: parentId,
    is_draft_preview: { $ne: true },
  })
    .populate("user", "email username name companyName")
    .catch(() => null);
  if (listing) return { kind: "lotListing", doc: listing, parentId: String(listing._id) };

  return null;
}

function getPreviewDataObject(doc: any): Record<string, any> {
  return doc?.preview_data && typeof doc.preview_data === "object" ? doc.preview_data : {};
}

async function saveCrDisclaimersOnTarget(
  target: NonNullable<Awaited<ReturnType<typeof resolveAssetOrLotListingTarget>>>,
  payload: any
) {
  const previewData = getPreviewDataObject(target.doc);
  const nextPreviewData: Record<string, any> = { ...previewData };
  const rawLots = Array.isArray(payload?.lots) ? payload.lots : null;
  const rawSettings = payload?.settings || payload?.cr_disclaimers || (!rawLots ? payload : undefined);
  let settings = normalizeCrDisclaimers(nextPreviewData.cr_disclaimers);
  if (rawSettings) {
    settings = normalizeCrDisclaimers(rawSettings);
    nextPreviewData.cr_disclaimers = settings;
  }
  if (rawLots) {
    const byLot: Record<string, any> = {};
    for (const item of rawLots) {
      const lotKey = String(item?.lotKey || item?.key || "").trim();
      if (!lotKey) continue;
      byLot[lotKey] = normalizeCrDisclaimers(item?.settings || item);
    }
    nextPreviewData.cr_disclaimers_by_lot = byLot;
  }
  target.doc.preview_data = {
    ...nextPreviewData,
  };
  if (typeof target.doc.markModified === "function") {
    target.doc.markModified("preview_data");
  }
  if (target.kind === "asset") {
    const set: Record<string, unknown> = {};
    if (rawSettings) {
      set["preview_data.cr_disclaimers"] = nextPreviewData.cr_disclaimers;
    }
    if (rawLots) {
      set["preview_data.cr_disclaimers_by_lot"] =
        nextPreviewData.cr_disclaimers_by_lot;
    }
    if (Object.keys(set).length) {
      const updated = await AssetReport.updateOne(
        {
          _id: target.parentId,
          updatedAt: target.doc.updatedAt,
          ...proposalValuationWritableRevisionCondition(
            Number(target.doc?.proposal_valuation_revision || 0)
          ),
        },
        { $set: set }
      );
      if (updated.matchedCount !== 1) {
        throw Object.assign(
          new Error(
            "The report changed while CR disclaimers were being saved. Refresh and retry."
          ),
          { code: "REPORT_REVISION_CHANGED", statusCode: 409 }
        );
      }
    }
    target.doc.unmarkModified?.("preview_data");
  } else {
    await target.doc.save();
  }
  return {
    settings,
    reportData: buildSpecReportData(target.doc),
  };
}

function appendUniqueImageUrl(urls: string[], value: unknown) {
  const url = String(value || "").trim();
  if (!url || urls.includes(url)) return;
  urls.push(url);
}

const IMAGE_VALUE_KEYS = [
  "url",
  "uri",
  "src",
  "href",
  "image_url",
  "imageUrl",
  "image",
  "thumbnail",
  "thumbnail_url",
  "thumbnailUrl",
  "cover_image_url",
  "coverImageUrl",
  "photo_url",
  "photoUrl",
  "displayUri",
  "originalUri",
  "editedUri",
  "r2Url",
  "publicUrl",
];

const LOT_IMAGE_ARRAY_KEYS = [
  "image_urls",
  "imageUrls",
  "extra_image_urls",
  "extraImageUrls",
  "photo_urls",
  "photoUrls",
  "photos",
  "images",
  "files",
  "extraFiles",
  "mainImages",
  "extraImages",
  "media",
  "attachments",
];

const LOT_IMAGE_INDEX_KEYS = [
  "image_index",
  "imageIndex",
  "image_indexes",
  "imageIndexes",
  "extra_image_indexes",
  "extraImageIndexes",
  "photo_indexes",
  "photoIndexes",
  "file_indexes",
  "fileIndexes",
];

function collectImageUrlCandidates(urls: string[], value: unknown, depth = 0) {
  if (value == null || depth > 4) return;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (
      /^https?:\/\//i.test(trimmed) ||
      /^data:image\//i.test(trimmed) ||
      trimmed.startsWith("/") ||
      /\.(jpe?g|png|webp|gif|heic|heif)(\?|#|$)/i.test(trimmed)
    ) {
      appendUniqueImageUrl(urls, trimmed);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectImageUrlCandidates(urls, item, depth + 1);
    return;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of IMAGE_VALUE_KEYS) {
      collectImageUrlCandidates(urls, record[key], depth + 1);
    }
  }
}

function normalizedLotMatchValue(value: unknown): string {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function collectReportImageUrls(reportData: any, sourceDoc?: any): string[] {
  const urls: string[] = [];
  const sources = [
    reportData?.imageUrls,
    reportData?.image_urls,
    reportData?.images,
    reportData?.photos,
    reportData?.preview_data?.imageUrls,
    reportData?.preview_data?.image_urls,
    reportData?.preview_data?.images,
    reportData?.preview_data?.photos,
    sourceDoc?.imageUrls,
    sourceDoc?.image_urls,
    sourceDoc?.images,
    sourceDoc?.photos,
    sourceDoc?.preview_data?.imageUrls,
    sourceDoc?.preview_data?.image_urls,
    sourceDoc?.preview_data?.images,
    sourceDoc?.preview_data?.photos,
  ];
  for (const source of sources) {
    collectImageUrlCandidates(urls, source);
  }
  return urls;
}

function buildLotImageCandidateList(reportData: any, sourceDoc: any, lot: any, index: number): any[] {
  const candidates: any[] = [];
  const seen = new Set<any>();
  const pushCandidate = (candidate: any) => {
    if (!candidate || seen.has(candidate)) return;
    seen.add(candidate);
    candidates.push(candidate);
  };

  pushCandidate(lot);

  const pools = [
    reportData?.lots,
    reportData?.preview_data?.lots,
    sourceDoc?.preview_data?.lots,
    sourceDoc?.lots,
    sourceDoc?.previewData?.lots,
  ];

  const lotId = normalizedLotMatchValue(lot?.lot_id || lot?.id || lot?._id);
  const lotNumber = normalizedLotMatchValue(lot?.lot_number);

  for (const pool of pools) {
    const list = Array.isArray(pool) ? pool : [];
    pushCandidate(list[index]);
    if (lotId || lotNumber) {
      for (const candidate of list) {
        const candidateId = normalizedLotMatchValue(candidate?.lot_id || candidate?.id || candidate?._id);
        const candidateLotNumber = normalizedLotMatchValue(candidate?.lot_number);
        if ((lotId && candidateId === lotId) || (lotNumber && candidateLotNumber === lotNumber)) {
          pushCandidate(candidate);
        }
      }
    }
  }

  return candidates;
}

function collectLotImageIndexes(lot: any): number[] {
  const indexes: number[] = [];
  for (const key of LOT_IMAGE_INDEX_KEYS) {
    const rawValue = lot?.[key];
    const rawIndexes = Array.isArray(rawValue) ? rawValue : rawValue == null ? [] : [rawValue];
    for (const value of rawIndexes) {
      const imageIndex = Number(value);
      if (Number.isInteger(imageIndex) && imageIndex >= 0 && !indexes.includes(imageIndex)) {
        indexes.push(imageIndex);
      }
    }
  }
  return indexes;
}

function buildCrDisclaimerLotImages(reportData: any, lot: any, index: number, sourceDoc?: any): string[] {
  const urls: string[] = [];
  const reportImageUrls = collectReportImageUrls(reportData, sourceDoc);
  const lots = Array.isArray(reportData?.lots) ? reportData.lots : [];
  const candidates = buildLotImageCandidateList(reportData, sourceDoc, lot, index);

  for (const candidate of candidates) {
    const nestedCandidates = [
      candidate,
      ...(Array.isArray(candidate?.items) ? candidate.items : []),
      ...(Array.isArray(candidate?.lots) ? candidate.lots : []),
    ];
    for (const nestedCandidate of nestedCandidates) {
      for (const key of IMAGE_VALUE_KEYS) {
        collectImageUrlCandidates(urls, nestedCandidate?.[key]);
      }
      for (const key of LOT_IMAGE_ARRAY_KEYS) {
        collectImageUrlCandidates(urls, nestedCandidate?.[key]);
      }
      for (const imageIndex of collectLotImageIndexes(nestedCandidate)) {
        collectImageUrlCandidates(urls, reportImageUrls[imageIndex]);
      }
    }
  }

  if (!urls.length && lots.length <= 1) {
    collectImageUrlCandidates(urls, reportImageUrls);
  }

  return urls.slice(0, 16);
}

function buildCrDisclaimerLots(reportData: any, sourceDoc?: any) {
  const lots = Array.isArray(reportData?.lots) ? reportData.lots : [];
  return lots.map((lot: any, index: number) => {
    const lotKey = getCrDisclaimerLotKey(lot, index);
    const lotNumber = String(lot?.lot_number || index + 1).trim();
    const title = String(lot?.title || lot?.description || `Lot ${lotNumber}`).trim();
    const settings = getCrDisclaimersForLot(reportData, lot, index);
    return {
      lotKey,
      lotNumber,
      title,
      imageUrls: buildCrDisclaimerLotImages(reportData, lot, index, sourceDoc),
      settings,
      activeCount: countActiveCrDisclaimers(settings),
    };
  });
}

function buildPdfReportDownloadName(report: any, ext: string, origName: string): string {
  const reportType = String(report?.reportType || "").toLowerCase();
  const contractNo = String(report?.contract_no || "").trim();
  const reportId = String(report?.report || report?._id || "").trim();
  const fileType = String(report?.fileType || "").toLowerCase();

  if ((reportType === "asset" || reportType === "lotlisting") && (contractNo || reportId)) {
    const names = buildReportArtifactFilenames({
      kind: reportType === "lotlisting" ? "lotListing" : "asset",
      contractNo: contractNo || reportId,
      reportId,
      fallback: origName,
      lots: getReportLots(report),
    });
    if (fileType === "xlsx") return names.excel;
    if (fileType === "spec_pdf") return names.crPdf;
    if (fileType === "cr_docx") return names.crDocx;
    if (fileType === "docx") return names.docx;
    if (fileType === "images" || ext === ".zip") return names.imagesZip;
    return `${names.base}${ext}`;
  }

  const prefix = reportType === "realestate" ? "real-estate" : reportType || "report";
  return contractNo ? `${prefix}-${contractNo}${ext}` : origName;
}

// @desc    Download a specific report
// @route   GET /api/reports/:id/download
// @access  Private
export const downloadReport = async (req: AuthRequest, res: Response) => {
  try {
    const report = await PdfReport.findById(req.params.id);
    if (!report) {
      return res.status(404).json({ message: "Report not found" });
    }

    const role = (req as any)?.user?.role as string | undefined;
    const isAdmin = role === "admin" || role === "superadmin";
    // Non-admin users must be the owner
    if (!isAdmin) {
      if (String(report.user) !== String(req.userId)) {
        return res.status(403).json({ message: "Not authorized to download this report" });
      }
    }
    const downloadAccess = getReportDownloadAccess(report);
    if (!downloadAccess.allowed) {
      return res.status(409).json({
        code: downloadAccess.code,
        message: downloadAccess.message,
        download_access: downloadAccess,
      });
    }

    const canonicalSalvage = await assertCurrentSalvagePdfArtifact(report);
    if (canonicalSalvage) {
      await assertLegacyPdfReportGroupFilesReady(report, true);
      const location = resolveR2ObjectLocationFromUrl(String(report.filePath || ""));
      if (!location) return res.status(409).json({ code: "FILES_UNAVAILABLE", message: "The current report file is unavailable. Regenerate the report files." });
      // The URL must match this parent's published generation before resolving
      // its configured R2 bucket/key. Never fetch a user-supplied remote URL.
      const object = await getR2ObjectStream(location.bucketName, location.key);
      const filename = String(report.filename || `salvage.${report.fileType === "images" ? "zip" : report.fileType}`);
      res.attachment(buildPdfReportDownloadName(report, path.extname(filename), filename));
      res.setHeader("Content-Type", object.contentType || "application/octet-stream");
      res.setHeader("Cache-Control", "private, no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      if (object.contentLength !== undefined) res.setHeader("Content-Length", object.contentLength);
      await pipeline(object.stream, res);
      return;
    }

    const preferred = (report as any).filePath as string | undefined;
    const candidates: string[] = [];
    if (preferred && preferred.trim().length > 0) {
      candidates.push(path.resolve(process.cwd(), preferred));
      const parts = preferred.split(/[\\/]+/).filter(Boolean);
      candidates.push(path.resolve(process.cwd(), ...parts));
    }
    candidates.push(path.resolve(process.cwd(), "reports", report.filename));
    if (process.env.REPORTS_DIR) {
      candidates.push(path.resolve(process.env.REPORTS_DIR, report.filename));
    }

    let found: string | null = null;
    for (const p of candidates) {
      try {
        await fs.access(p);
        found = p;
        break;
      } catch {}
    }
    if (!found) {
      return res.status(404).json({ message: "File not found on server" });
    }
    const origName = (report as any)?.filename || path.basename(found);
    let ext = path.extname(origName);
    if (!ext) {
      const ft = ((report as any)?.fileType || "") as string;
      ext = ft === "images" ? ".zip" : ft ? `.${ft}` : "";
    }
    const downloadName = buildPdfReportDownloadName(report, ext, origName);
    res.download(found, downloadName);
  } catch (error: any) {
    if (res.headersSent) return;
    if (error?.statusCode === 409) return res.status(409).json({ code: error.code, message: error.message });
    if (isR2ObjectNotFoundError(error)) return res.status(404).json({ message: "Report file not found. Regenerate the report files." });
    res.status(500).json({ message: "Could not download the report. Please try again." });
  }
};

// @desc    Get structured preview data for a specific report
// @route   GET /api/reports/:id/preview
// @access  Private
export const getReportPreview = async (req: AuthRequest, res: Response) => {
  try {
    const preview = await getReportPreviewPayloadById(req.params.id);
    if (!preview) {
      return res.status(404).json({ message: "Report not found" });
    }

    const role = (req as any)?.user?.role as string | undefined;
    const isAdmin = role === "admin" || role === "superadmin";
    const ownerId = String(preview.ownerId || "").trim();

    if (!isAdmin) {
      if (!ownerId || ownerId !== String(req.userId || "")) {
        return res.status(403).json({ message: "Not authorized to view this report" });
      }
    }

    const { ownerId: _ownerId, ...safePreview } = preview;
    return res.status(200).json(safePreview);
  } catch (error) {
    res.status(500).json({ message: "Server error", error });
  }
};

function redirectToCrPdf(res: Response, url: string, generated: boolean) {
  res.setHeader("Cache-Control", generated ? "no-store" : "private, max-age=30");
  res.setHeader("X-CR-Generated", generated ? "1" : "0");
  return res.redirect(302, url);
}

function safeCrDownloadName(reportType: "Asset" | "LotListing", contractNo: string, reportId?: string, lots?: any[]) {
  return buildReportArtifactFilenames({
    kind: reportType === "LotListing" ? "lotListing" : "asset",
    contractNo,
    reportId,
    fallback: reportId || contractNo,
    lots,
  }).crPdf;
}

function safeCrDocxDownloadName(reportType: "Asset" | "LotListing", contractNo: string, reportId?: string, lots?: any[]) {
  return buildReportArtifactFilenames({
    kind: reportType === "LotListing" ? "lotListing" : "asset",
    contractNo,
    reportId,
    fallback: reportId || contractNo,
    lots,
  }).crDocx;
}

async function downloadCrPdfToResponse(
  req: AuthRequest,
  res: Response,
  options: { isAdmin?: boolean }
) {
  const resolved = await resolveCrPdfAccessById(req.params.id, {
    userId: String(req.userId || ""),
    isAdmin: options.isAdmin,
    generateIfMissing: true,
    requireDownloadable: true,
  });
  if (!resolved) {
    return res.status(404).json({ message: "CR not found" });
  }

  const filename = safeCrDownloadName(resolved.reportType, resolved.contractNo || req.params.id, resolved.reportId || req.params.id, resolved.lots);
  const pdfResponse = await axios.get(resolved.url, {
    responseType: "stream",
    timeout: 120000,
    headers: { Accept: "application/pdf,*/*" },
  });

  const upstreamContentType = pdfResponse.headers["content-type"];
  res.setHeader(
    "Content-Type",
    typeof upstreamContentType === "string"
      ? upstreamContentType
      : "application/pdf"
  );
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Cache-Control", resolved.generated ? "no-store" : "private, max-age=30");
  res.setHeader("X-CR-Generated", resolved.generated ? "1" : "0");
  const length = pdfResponse.headers["content-length"];
  if (typeof length === "string" || typeof length === "number") {
    res.setHeader("Content-Length", length);
  }
  return pdfResponse.data.pipe(res);
}

async function downloadCrDocxToResponse(
  req: AuthRequest,
  res: Response,
  options: { isAdmin?: boolean }
) {
  const resolved = await resolveCrDocxAccessById(req.params.id, {
    userId: String(req.userId || ""),
    isAdmin: options.isAdmin,
    generateIfMissing: true,
    requireDownloadable: true,
  });
  if (!resolved) {
    return res.status(404).json({ message: "CR DOCX not found" });
  }

  const filename = safeCrDocxDownloadName(resolved.reportType, resolved.contractNo || req.params.id, resolved.reportId || req.params.id, resolved.lots);
  const docxResponse = await axios.get(resolved.url, {
    responseType: "stream",
    timeout: 120000,
    headers: { Accept: `${CR_DOCX_CONTENT_TYPE},application/octet-stream,*/*` },
  });

  const upstreamContentType = docxResponse.headers["content-type"];
  res.setHeader(
    "Content-Type",
    typeof upstreamContentType === "string"
      ? upstreamContentType
      : CR_DOCX_CONTENT_TYPE
  );
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Cache-Control", resolved.generated ? "no-store" : "private, max-age=30");
  res.setHeader("X-CR-DOCX-Generated", resolved.generated ? "1" : "0");
  const length = docxResponse.headers["content-length"];
  if (typeof length === "string" || typeof length === "number") {
    res.setHeader("Content-Length", length);
  }
  return docxResponse.data.pipe(res);
}

// @desc    Open stored CR for Asset/Lot Listing reports, generating once only if missing
// @route   GET /api/admin/reports/:id/spec-pdf
// @access  Admin
export const streamAdminSpecPdf = async (req: AuthRequest, res: Response) => {
  try {
    const role = (req as any)?.user?.role as string | undefined;
    const isAdmin = role === "admin" || role === "superadmin";
    if (!isAdmin) {
      return res.status(403).json({ message: "Admin privileges required" });
    }

    const resolved = await resolveCrPdfAccessById(req.params.id, {
      isAdmin: true,
      generateIfMissing: true,
    });
    if (!resolved) {
      return res.status(404).json({ message: "Asset or lot listing report not found" });
    }

    return redirectToCrPdf(res, resolved.url, resolved.generated);
  } catch (error: any) {
    console.error("streamAdminSpecPdf error:", error);
    return res.status(500).json({
      message: error?.message || "Failed to generate CR",
    });
  }
};

// @desc    Download stored CR for Asset/Lot Listing reports
// @route   GET /api/admin/reports/:id/spec-pdf/download
// @access  Admin
export const downloadAdminSpecPdf = async (req: AuthRequest, res: Response) => {
  try {
    const role = (req as any)?.user?.role as string | undefined;
    const isAdmin = role === "admin" || role === "superadmin";
    if (!isAdmin) {
      return res.status(403).json({ message: "Admin privileges required" });
    }

    return await downloadCrPdfToResponse(req, res, { isAdmin: true });
  } catch (error: any) {
    const statusCode = Number(error?.statusCode || 500);
    const responseStatus = statusCode === 403 || statusCode === 409 ? statusCode : 500;
    if (responseStatus === 500) {
      console.error("downloadAdminSpecPdf error:", error);
    }
    return res.status(responseStatus).json({
      ...(error?.code ? { code: error.code } : {}),
      message: error?.message || "Failed to download CR",
      ...(error?.downloadAccess ? { download_access: error.downloadAccess } : {}),
    });
  }
};

// @desc    Download stored/generated CR DOCX for Asset/Lot Listing reports
// @route   GET /api/admin/reports/:id/cr-docx
// @access  Admin
export const downloadAdminCrDocx = async (req: AuthRequest, res: Response) => {
  try {
    const role = (req as any)?.user?.role as string | undefined;
    const isAdmin = role === "admin" || role === "superadmin";
    if (!isAdmin) {
      return res.status(403).json({ message: "Admin privileges required" });
    }

    return await downloadCrDocxToResponse(req, res, { isAdmin: true });
  } catch (error: any) {
    const statusCode = Number(error?.statusCode || 500);
    const responseStatus = statusCode === 403 || statusCode === 409 ? statusCode : 500;
    if (responseStatus === 500) {
      console.error("downloadAdminCrDocx error:", error);
    }
    return res.status(responseStatus).json({
      ...(error?.code ? { code: error.code } : {}),
      message: error?.message || "Failed to download CR DOCX",
      ...(error?.downloadAccess ? { download_access: error.downloadAccess } : {}),
    });
  }
};

// @desc    Open stored CR for the current user's Asset/Lot Listing report
// @route   GET /api/reports/:id/cr
// @access  Private
export const openReportCr = async (req: AuthRequest, res: Response) => {
  try {
    const role = (req as any)?.user?.role as string | undefined;
    const isAdmin = role === "admin" || role === "superadmin";
    const resolved = await resolveCrPdfAccessById(req.params.id, {
      userId: String(req.userId || ""),
      isAdmin,
      generateIfMissing: true,
    });
    if (!resolved) {
      return res.status(404).json({ message: "CR not found" });
    }

    return redirectToCrPdf(res, resolved.url, resolved.generated);
  } catch (error: any) {
    const statusCode = Number(error?.statusCode || 500);
    if (statusCode === 403 || statusCode === 409) {
      return res.status(statusCode).json({
        ...(error?.code ? { code: error.code } : {}),
        message: error?.message || "Not authorized to view this CR",
        ...(error?.downloadAccess ? { download_access: error.downloadAccess } : {}),
      });
    }
    console.error("openReportCr error:", error);
    return res.status(500).json({ message: error?.message || "Failed to open CR" });
  }
};

// @desc    Download stored CR for the current user's Asset/Lot Listing report
// @route   GET /api/reports/:id/cr/download
// @access  Private
export const downloadReportCr = async (req: AuthRequest, res: Response) => {
  try {
    const role = (req as any)?.user?.role as string | undefined;
    const isAdmin = role === "admin" || role === "superadmin";
    return await downloadCrPdfToResponse(req, res, { isAdmin });
  } catch (error: any) {
    const statusCode = Number(error?.statusCode || 500);
    if (statusCode === 403 || statusCode === 409) {
      return res.status(statusCode).json({
        ...(error?.code ? { code: error.code } : {}),
        message: error?.message || "Not authorized to download this CR",
        ...(error?.downloadAccess ? { download_access: error.downloadAccess } : {}),
      });
    }
    console.error("downloadReportCr error:", error);
    return res.status(500).json({ message: error?.message || "Failed to download CR" });
  }
};

// @desc    Download stored/generated CR DOCX for the current user's Asset/Lot Listing report
// @route   GET /api/reports/:id/cr-docx
// @access  Private
export const downloadReportCrDocx = async (req: AuthRequest, res: Response) => {
  try {
    const role = (req as any)?.user?.role as string | undefined;
    const isAdmin = role === "admin" || role === "superadmin";
    return await downloadCrDocxToResponse(req, res, { isAdmin });
  } catch (error: any) {
    const statusCode = Number(error?.statusCode || 500);
    if (statusCode === 403 || statusCode === 409) {
      return res.status(statusCode).json({
        ...(error?.code ? { code: error.code } : {}),
        message: error?.message || "Not authorized to download this CR DOCX",
        ...(error?.downloadAccess ? { download_access: error.downloadAccess } : {}),
      });
    }
    console.error("downloadReportCrDocx error:", error);
    return res.status(500).json({ message: error?.message || "Failed to download CR DOCX" });
  }
};

// @desc    Get CR disclaimer selections for an Asset/Lot Listing report
// @route   GET /api/admin/reports/:id/cr-disclaimers
// @access  Admin
export const getAdminCrDisclaimers = async (req: AuthRequest, res: Response) => {
  try {
    const role = (req as any)?.user?.role as string | undefined;
    const isAdmin = role === "admin" || role === "superadmin";
    if (!isAdmin) {
      return res.status(403).json({ message: "Admin privileges required" });
    }

    const target = await resolveAssetOrLotListingTarget(req.params.id);
    if (!target) {
      return res.status(404).json({ message: "Asset or lot listing report not found" });
    }

    const reportData = buildSpecReportData(target.doc);
    const settings = normalizeCrDisclaimers(getPreviewDataObject(target.doc).cr_disclaimers);
    const lots = buildCrDisclaimerLots(reportData, target.doc);
    const activeLotCount = countLotsWithCrDisclaimers(reportData);
    return res.status(200).json({
      data: {
        reportType: target.kind === "asset" ? "Asset" : "LotListing",
        settings,
        lots,
        options: CR_DISCLAIMER_OPTIONS.map(({ key, label }) => ({ key, label })),
        activeCount: countActiveCrDisclaimers(settings),
        activeLotCount,
        files_regenerating: Boolean((target.doc as any).files_regenerating),
        files_generating: Boolean((target.doc as any).files_generating),
      },
    });
  } catch (error: any) {
    console.error("getAdminCrDisclaimers error:", error);
    return res.status(500).json({ message: error?.message || "Failed to load CR disclaimers" });
  }
};

// @desc    Save CR disclaimer selections for an Asset/Lot Listing report
// @route   PATCH /api/admin/reports/:id/cr-disclaimers
// @access  Admin
export const saveAdminCrDisclaimers = async (req: AuthRequest, res: Response) => {
  try {
    const role = (req as any)?.user?.role as string | undefined;
    const isAdmin = role === "admin" || role === "superadmin";
    if (!isAdmin) {
      return res.status(403).json({ message: "Admin privileges required" });
    }

    const target = await resolveAssetOrLotListingTarget(req.params.id);
    if (!target) {
      return res.status(404).json({ message: "Asset or lot listing report not found" });
    }

    const saved = await saveCrDisclaimersOnTarget(target, req.body);
    const lots = buildCrDisclaimerLots(saved.reportData, target.doc);
    const activeLotCount = countLotsWithCrDisclaimers(saved.reportData);
    return res.status(200).json({
      message: "CR disclaimers saved",
      data: {
        settings: saved.settings,
        lots,
        activeCount: countActiveCrDisclaimers(saved.settings),
        activeLotCount,
      },
    });
  } catch (error: any) {
    console.error("saveAdminCrDisclaimers error:", error);
    return res.status(Number(error?.statusCode || 500)).json({
      code: error?.code,
      message: error?.message || "Failed to save CR disclaimers",
    });
  }
};

// @desc    Resubmit only Excel and CR for an Asset/Lot Listing report
// @route   POST /api/admin/reports/:id/rerun-excel-cr
// @access  Admin
export const rerunAdminExcelAndCr = async (req: AuthRequest, res: Response) => {
  let savedEditor: Awaited<ReturnType<typeof saveExcelConditionReports>> | undefined;
  try {
    const role = (req as any)?.user?.role as string | undefined;
    const isAdmin = role === "admin" || role === "superadmin";
    if (!isAdmin) {
      return res.status(403).json({ message: "Admin privileges required" });
    }

    let target = await resolveAssetOrLotListingTarget(req.params.id);
    if (!target) {
      return res.status(404).json({ message: "Asset or lot listing report not found" });
    }
    if (target.doc.status !== "approved") {
      return res.status(400).json({ message: "Excel/CR resubmit is only available for approved reports" });
    }
    // The editor sends its complete row snapshot with regeneration. Persisting it
    // here makes save + regenerate one authoritative operation and prevents file
    // generation from observing an older document between separate requests.
    if (Array.isArray((req.body as any)?.rows) || (req.body as any)?.revision) {
      savedEditor = await saveExcelConditionReports(req.params.id, req.body, {
        requireFilesIdle: true,
      });
      const refreshedTarget = await resolveAssetOrLotListingTarget(req.params.id);
      if (!refreshedTarget) {
        return res.status(404).json({ message: "Asset or lot listing report not found" });
      }
      target = refreshedTarget;
    }

    const queued = await queueExcelCrRegenerationJob({
      kind: target.kind,
      reportId: target.parentId,
    });
    return res.status(202).json({
      message: "Changes saved. Excel and CR file regeneration is queued.",
      data: {
        queued: true,
        ...queued,
        saved: Boolean(savedEditor),
        editor: savedEditor,
      },
    });
  } catch (error: any) {
    console.error("rerunAdminExcelAndCr error:", error);
    const statusCode =
      error instanceof ExcelConditionReportError
        ? error.statusCode
        : Number(error?.statusCode || 500);
    return res.status(statusCode).json({
      code: error?.code || "EXCEL_CR_REGENERATION_ERROR",
      message: error?.message || "Failed to resubmit Excel/CR",
      data: savedEditor
        ? {
            saved: true,
            editor: savedEditor,
          }
        : undefined,
    });
  }
};

// @desc    Save asset admin schedule sheet
// @route   PATCH /api/reports/:id/asset-schedule-sheet
// @access  Admin
export const saveAssetAdminScheduleSheet = async (req: AuthRequest, res: Response) => {
  try {
    const role = (req as any)?.user?.role as string | undefined;
    const isAdmin = role === "admin" || role === "superadmin";
    if (!isAdmin) {
      return res.status(403).json({ message: "Admin privileges required" });
    }

    const nextSheet = (req.body as any)?.assetScheduleSheet;
    if (!nextSheet) {
      return res.status(400).json({ message: "assetScheduleSheet is required" });
    }

    const preview = await saveAssetAdminScheduleSheetById(
      req.params.id,
      nextSheet,
      {
        adminUserId: String(req.userId || req.user?._id || ""),
        baseRevision: (req.body as any)?.baseRevision,
      }
    );
    if (!preview) {
      return res.status(404).json({ message: "Asset report not found" });
    }

    const reportId = String((preview as any).reportId || "");
    const regeneration = reportId
      ? await queueAssetScheduleSheetRegeneration(
          reportId,
          Number((preview as any).revision || 0)
        )
      : { queued: false, coalesced: false };

    const { ownerId: _ownerId, ...safePreview } = preview;
    return res.status(200).json({
      ...safePreview,
      files_regeneration_queued: regeneration.queued,
      files_regeneration_coalesced: regeneration.coalesced,
      ...(regeneration.warning
        ? { files_regeneration_warning: regeneration.warning }
        : {}),
    });
  } catch (error: any) {
    if (error instanceof ProposalValuationError) {
      return res
        .status(error.statusCode)
        .json(proposalValuationErrorBody(error));
    }
    const message = error?.message || "Server error";
    const status = message.includes("Cannot update asset schedule sheet for status")
      ? 400
      : 500;
    return res.status(status).json({ message });
  }
};

// @desc    Delete a specific report
// @route   DELETE /api/reports/:id
// @access  Private
export const deleteReport = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    console.log(`[deleteReport] Attempting to delete report with ID: ${id}`);
    
    // First, try to find as a PdfReport
    let report = await PdfReport.findById(id);
    
    if (report) {
      // Found as PdfReport - delete single file
      console.log(`[deleteReport] Found PdfReport: ${report.filename}`);
      
      // Remove file from server
      const preferred = (report as any).filePath as string | undefined;
      const filePath = preferred && preferred.trim().length > 0
        ? path.resolve(process.cwd(), preferred)
        : path.resolve(process.cwd(), "reports", report.filename);
      try {
        await fs.unlink(filePath);
        console.log(`[deleteReport] Deleted file: ${filePath}`);
      } catch (e: any) {
        if (e?.code !== "ENOENT") throw e;
        console.log(`[deleteReport] File not found (already deleted): ${filePath}`);
      }

      await report.deleteOne();
      return res.json({ message: "Report removed successfully" });
    }
    
    // Not found as PdfReport - try as parent report ID (AssetReport/RealEstateReport)
    // Find all PdfReports that reference this parent report
    const relatedPdfReports = await PdfReport.find({ report: id as any });
    
    if (relatedPdfReports.length > 0) {
      console.log(`[deleteReport] Found ${relatedPdfReports.length} PdfReports linked to parent report ${id}`);
      
      // Delete all related files and records
      for (const pdfReport of relatedPdfReports) {
        const preferred = (pdfReport as any).filePath as string | undefined;
        const filePath = preferred && preferred.trim().length > 0
          ? path.resolve(process.cwd(), preferred)
          : path.resolve(process.cwd(), "reports", pdfReport.filename);
        try {
          await fs.unlink(filePath);
          console.log(`[deleteReport] Deleted file: ${filePath}`);
        } catch (e: any) {
          if (e?.code !== "ENOENT") throw e;
        }
        await pdfReport.deleteOne();
      }
      
      // Also try to delete the parent AssetReport if it exists
      try {
        const assetReport = await AssetReport.findById(id);
        if (assetReport) {
          await assetReport.deleteOne();
          console.log(`[deleteReport] Deleted parent AssetReport: ${id}`);
        }
      } catch (e) {
        console.log(`[deleteReport] No AssetReport found for ${id}`);
      }
      
      // Also try to delete the parent RealEstateReport if it exists
      try {
        const { default: RealEstateReport } = await import("../models/realEstate.model.js");
        const realEstateReport = await RealEstateReport.findById(id);
        if (realEstateReport) {
          await realEstateReport.deleteOne();
          console.log(`[deleteReport] Deleted parent RealEstateReport: ${id}`);
        }
      } catch (e) {
        console.log(`[deleteReport] No RealEstateReport found for ${id}`);
      }

      try {
        const lotListing = await LotListing.findById(id);
        if (lotListing) {
          await lotListing.deleteOne();
          console.log(`[deleteReport] Deleted parent LotListing: ${id}`);
        }
      } catch (e) {
        console.log(`[deleteReport] No LotListing found for ${id}`);
      }
      
      return res.json({ message: `${relatedPdfReports.length} report(s) removed successfully` });
    }
    
    // Still not found - try direct parent report deletion (for new workflow reports without PdfReport)
    try {
      const assetReport = await AssetReport.findById(id);
      if (assetReport) {
        await assetReport.deleteOne();
        console.log(`[deleteReport] Deleted AssetReport: ${id}`);
        return res.json({ message: "Asset report removed successfully" });
      }
    } catch (e) {
      console.log(`[deleteReport] Error checking AssetReport: ${e}`);
    }
    
    try {
      const { default: RealEstateReport } = await import("../models/realEstate.model.js");
      const realEstateReport = await RealEstateReport.findById(id);
      if (realEstateReport) {
        await realEstateReport.deleteOne();
        console.log(`[deleteReport] Deleted RealEstateReport: ${id}`);
        return res.json({ message: "Real estate report removed successfully" });
      }
    } catch (e) {
      console.log(`[deleteReport] Error checking RealEstateReport: ${e}`);
    }

    try {
      const lotListing = await LotListing.findById(id);
      if (lotListing) {
        await lotListing.deleteOne();
        console.log(`[deleteReport] Deleted LotListing: ${id}`);
        return res.json({ message: "Lot listing removed successfully" });
      }
    } catch (e) {
      console.log(`[deleteReport] Error checking LotListing: ${e}`);
    }
    
    // Nothing found
    console.log(`[deleteReport] No report found with ID: ${id}`);
    return res.status(404).json({ message: "Report not found" });
  } catch (error) {
    console.error("[deleteReport] Error:", error);
    res.status(500).json({ message: "Server error", error });
  }
};

// @desc    Get all reports
// @route   GET /api/reports
// @access  Private (Admin)
export const getAllReports = async (req: AuthRequest, res: Response) => {
  try {
    const filter: Record<string, any> = req.user?.isReviewAccount === true ? { user: req.userId } : await productionReportOwnerFilter();
    const reports = await PdfReport.find(filter)
      .populate("user", "name email")
      .populate("report");
    res.json(reports);
  } catch (error) {
    res.status(500).json({ message: "Server error", error });
  }
};

// @desc    Get reports for the logged-in user
// @route   GET /api/reports/myreports
// @access  Private
export const getReportsByUser = async (req: AuthRequest, res: Response) => {
  try {
    // Get old-style PdfReports
    const pdfReports = await PdfReport.find({ user: req.userId as any })
      .populate({
        path: 'report',
        select: 'valuation_data include_valuation_table valuation_methods',
      })
      .sort({ createdAt: -1 })
      .lean();
    
    // Get new-style approved AssetReports
    const approvedAssetReports = await AssetReport.find({ 
      user: req.userId as any,
      status: 'approved',
      is_draft_preview: { $ne: true },
    })
      .sort({ createdAt: -1 })
      .lean();

    // Get new-style approved LotListings. Lot listings are not stored as PdfReport
    // rows, so include them here for clients that use /reports/myreports only.
    const approvedLotListings = await LotListing.find({
      user: req.userId as any,
      status: 'approved',
      is_draft_preview: { $ne: true },
    })
      .sort({ createdAt: -1 })
      .lean();
    
    // Convert PdfReports to result format
    const pdfResults = (await filterCurrentPdfReportArtifacts(pdfReports || [])).map((r: any) => {
      const populatedReport = r.report as any;
      const downloadAccess = getReportDownloadAccess(r);
      let valuationMethods: any[] = [];
      if (populatedReport?.include_valuation_table && populatedReport?.valuation_data?.methods) {
        valuationMethods = populatedReport.valuation_data.methods.map((m: any) => ({
          method: m.method,
          value: m.value,
        }));
      }
      
      // Ensure fairMarketValue is properly formatted with currency
      let fmv = r.fairMarketValue;
      const currency = populatedReport?.currency || 'CAD';
      
      if (fmv && typeof fmv === 'number') {
        // If it's a raw number, format it with currency
        fmv = new Intl.NumberFormat('en-US', { 
          style: 'currency', 
          currency, 
          maximumFractionDigits: 0 
        }).format(fmv);
      } else if (!fmv || fmv === '0' || fmv === 0) {
        // If empty or zero, show currency code
        fmv = `${currency} 0.00`;
      }
      
      return { 
        ...r,
        report: populatedReport?._id || r.report,
        fairMarketValue: fmv,
        type: r.type ?? r.reportType,
        release_status: releaseStatusForPayload(r),
        release_assigned_to: r.release_assigned_to || null,
        released_at: r.released_at || null,
        downloadable: downloadAccess.allowed,
        download_access: downloadAccess,
        valuationMethods: valuationMethods.length > 0 ? valuationMethods : undefined,
      };
    });
    
    // Convert approved AssetReports to match PdfReport format
    const assetResults = (approvedAssetReports || []).map((r: any) => {
      const previewData = r.preview_data || {};
      
      // Calculate and format FMV with currency
      const currency = String(previewData?.currency || r.currency || 'CAD').toUpperCase();
      const baseFMV = previewData?.valuation_data?.baseFMV;
      const lots: any[] = Array.isArray(previewData?.lots) ? previewData.lots : (Array.isArray(r.lots) ? r.lots : []);
      const sumFromLots = (lots || []).reduce((acc: number, lot: any) => {
        const raw = typeof lot?.estimated_value === 'string' ? lot.estimated_value : '';
        const num = parseFloat(String(raw).replace(/[^0-9.-]+/g, ''));
        return acc + (Number.isFinite(num) ? num : 0);
      }, 0);
      const total = Number.isFinite(baseFMV as any) ? (baseFMV as number) : sumFromLots;
      const fmvStr = total > 0 
        ? new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 0 }).format(total)
        : `${currency} 0.00`;
      
      let valuationMethods: any[] = [];
      if (r.include_valuation_table && r.valuation_data?.methods) {
        valuationMethods = r.valuation_data.methods.map((m: any) => ({
          method: m.method,
          value: m.value,
        }));
      }
      
      const workflowAccess = getReportDownloadAccess(r);
      const generation = resolveReportGenerationStateForProfile(
        "asset",
        r,
        r.preview_files,
        r.files
      );
      const downloadAccess = getReportDownloadAccessForGeneration(r, generation);
      const downloadable = downloadAccess.allowed;
      const canExposeStoredFiles =
        workflowAccess.allowed &&
        !["queued", "processing"].includes(generation.generation_state) &&
        String(r.job_status || "").toLowerCase() !== "error";
      const previewFiles = canExposeStoredFiles ? r.preview_files : {};
      const thumbnailUrl = lots.length
        ? buildCrDisclaimerLotImages(previewData, lots[0], 0, r)[0] || null
        : collectReportImageUrls(previewData, r)[0] || null;

      return {
        _id: r._id,
        user: r.user,
        type: 'Asset',
        reportType: 'Asset',
        clientName: previewData.client_name || previewData.prepared_for || '',
        address: previewData.client_name || previewData.prepared_for || 'Asset Report',
        filename: `${previewData.client_name || 'Asset Report'}.docx`,
        fairMarketValue: fmvStr,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        status: 'approved',
        approvalStatus: 'approved',
        contract_no: previewData.contract_no,
        lot_count: lots.length,
        thumbnail_url: thumbnailUrl,
        valuationMethods: valuationMethods.length > 0 ? valuationMethods : undefined,
        release_status: releaseStatusForPayload(r),
        release_assigned_to: r.release_assigned_to || null,
        released_at: r.released_at || null,
        downloadable,
        download_access: downloadAccess,
        preview_files: previewFiles,
        ...generation,
        files_generating: ["queued", "processing"].includes(generation.generation_state),
        files_regenerating:
          Boolean(r.files_regenerating) &&
          generation.generation_state === "processing",
      };
    });

    const lotListingResults = (approvedLotListings || []).map((r: any) => {
      const previewData = r.preview_data || {};
      const contractNo = previewData.contract_no || r.contract_no || "Lot Listing";
      const location = previewData.location || r.location || "";
      const lots: any[] = Array.isArray(previewData.lots)
        ? previewData.lots
        : Array.isArray(r.lots)
          ? r.lots
          : [];
      const workflowAccess = getReportDownloadAccess(r);
      const generation = resolveReportGenerationStateForProfile(
        "lotListing",
        r,
        r.preview_files,
        r.files
      );
      const downloadAccess = getReportDownloadAccessForGeneration(r, generation);
      const downloadable = downloadAccess.allowed;
      const canExposeStoredFiles =
        workflowAccess.allowed &&
        !["queued", "processing"].includes(generation.generation_state) &&
        String(r.job_status || "").toLowerCase() !== "error";
      const files = canExposeStoredFiles ? {
        ...(r.files || {}),
        ...(r.preview_files || {}),
      } : {};
      const artifactNames = buildReportArtifactFilenames({
        kind: "lotListing",
        contractNo,
        reportId: r._id,
        fallback: r._id,
        lots,
      });
      const thumbnailUrl = lots.length
        ? buildCrDisclaimerLotImages(previewData, lots[0], 0, r)[0] || null
        : collectReportImageUrls(previewData, r)[0] || null;

      return {
        _id: r._id,
        user: r.user,
        type: "LotListing",
        reportType: "LotListing",
        address: location ? `${contractNo} - ${location}` : contractNo,
        filename: artifactNames.excel,
        fairMarketValue: `${lots.length} lots`,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        status: "approved",
        approvalStatus: "approved",
        release_status: releaseStatusForPayload(r),
        release_assigned_to: r.release_assigned_to || null,
        released_at: r.released_at || null,
        downloadable,
        download_access: downloadAccess,
        contract_no: contractNo,
        lot_count: lots.length,
        thumbnail_url: thumbnailUrl,
        preview_files: files,
        files,
        ...generation,
        files_generating: ["queued", "processing"].includes(generation.generation_state),
        files_regenerating:
          Boolean(r.files_regenerating) &&
          generation.generation_state === "processing",
        isLotListing: true,
      };
    });
    
    // Combine and sort by createdAt (newest first)
    const allReports = [...pdfResults, ...assetResults, ...lotListingResults].sort((a: any, b: any) => {
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
    
    res.json(allReports);
  } catch (error) {
    res.status(500).json({ message: "Server error", error });
  }
};

// @desc    Get report statistics for the logged-in user
// @route   GET /api/reports/stats
// @access  Private
export const getReportStats = async (req: AuthRequest, res: Response) => {
  try {
    const reports = await PdfReport.find({ user: req.userId as any }).lean();

    const groups = new Map<string, any>();
    for (const r of reports || []) {
      const key = String((r as any).report || (r as any)._id);
      if (!groups.has(key)) groups.set(key, r);
    }

    let totalFairMarketValue = 0;
    // Track valuation method breakdown
    const methodCounts: Record<string, number> = { FMV: 0, OLV: 0, FLV: 0, TKV: 0 };
    const methodValues: Record<string, number> = { FMV: 0, OLV: 0, FLV: 0, TKV: 0 };
    const processedReports = new Set<string>();

    // Process completed PdfReports (already approved/generated)
    for (const r of groups.values()) {
      const fmv = (r as any)?.fairMarketValue;
      if (fmv && typeof fmv === "string") {
        try {
          const numericString = fmv.replace(/[^\d.-]/g, "");
          const value = parseFloat(numericString);
          if (!isNaN(value)) totalFairMarketValue += value;
        } catch {}
      }

      // Process valuation breakdown from PdfReport
      const reportKey = String((r as any).report || (r as any)._id);
      if ((r as any).valuation_data && !processedReports.has(reportKey)) {
        processedReports.add(reportKey);
        const vData = (r as any).valuation_data;
        const methods = vData.methods || [];
        
        console.log(`[Stats] Processing PdfReport ${reportKey} with ${methods.length} valuation methods:`, methods.map((m: any) => m.method));
        
        for (const m of methods) {
          const method = String(m.method || "").toUpperCase();
          if (method === "FMV" || method === "FML") {
            methodCounts.FMV += 1;
            methodValues.FMV += m.value || 0;
          } else if (method === "OLV") {
            methodCounts.OLV += 1;
            methodValues.OLV += m.value || 0;
          } else if (method === "FLV") {
            methodCounts.FLV += 1;
            methodValues.FLV += m.value || 0;
          } else if (method === "TKV") {
            methodCounts.TKV += 1;
            methodValues.TKV += m.value || 0;
          }
        }
      }
    }

    // Process ALL AssetReports (pending AND approved) to get valuation data
    const allAssets = await AssetReport.find({
      user: req.userId as any,
      status: { $in: ["preview", "pending_approval", "approved"] },
      is_draft_preview: { $ne: true },
    })
      .select("_id preview_data lots valuation_methods valuation_data include_valuation_table status")
      .lean();

    console.log(`[Stats] Found ${allAssets.length} total AssetReports (pending + approved)`);

    for (const ar of allAssets || []) {
      const key = String((ar as any)._id);
      if (groups.has(key)) continue;
      let total = 0;
      const pd = (ar as any).preview_data || {};
      const raw = (pd as any).total_value ?? (pd as any).total_appraised_value;
      if (typeof raw === "number") {
        total = raw;
      } else if (raw != null) {
        const parsed = parseFloat(String(raw).replace(/[^0-9.-]+/g, ""));
        total = Number.isFinite(parsed) ? parsed : 0;
      } else if (Array.isArray((ar as any).lots)) {
        total = ((ar as any).lots as any[]).reduce((acc: number, lot: any) => {
          const v = parseFloat(String(lot?.estimated_value || "").replace(/[^0-9.-]+/g, ""));
          return acc + (Number.isFinite(v) ? v : 0);
        }, 0);
      }
      if (total > 0) totalFairMarketValue += total;
      groups.set(key, ar);

      // Process valuation breakdown from pending AssetReport if not already processed
      if ((ar as any).include_valuation_table && (ar as any).valuation_data && !processedReports.has(key)) {
        processedReports.add(key);
        const vData = (ar as any).valuation_data;
        const methods = vData.methods || [];
        
        console.log(`[Stats] Processing pending AssetReport ${key} with ${methods.length} valuation methods:`, methods.map((m: any) => m.method));
        
        for (const m of methods) {
          const method = String(m.method || "").toUpperCase();
          if (method === "FMV" || method === "FML") {
            methodCounts.FMV += 1;
            methodValues.FMV += m.value || 0;
          } else if (method === "OLV") {
            methodCounts.OLV += 1;
            methodValues.OLV += m.value || 0;
          } else if (method === "FLV") {
            methodCounts.FLV += 1;
            methodValues.FLV += m.value || 0;
          } else if (method === "TKV") {
            methodCounts.TKV += 1;
            methodValues.TKV += m.value || 0;
          }
        }
      }
    }

    const totalReports = groups.size;
    
    console.log('[Stats] Final breakdown:', {
      totalReports,
      totalFairMarketValue,
      counts: methodCounts,
      values: methodValues,
    });
    
    res.json({ 
      totalReports, 
      totalFairMarketValue,
      breakdown: {
        counts: methodCounts,
        values: methodValues,
      },
    });
  } catch (error) {
    console.error("Error in getReportStats:", error);
    res.status(500).json({ message: "Server error", error });
  }
};
