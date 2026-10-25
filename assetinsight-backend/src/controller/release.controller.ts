import { Response } from "express";
import { Types } from "mongoose";
import AssetReport from "../models/asset.model.js";
import LotListing from "../models/lotListing.model.js";
import PdfReport from "../models/pdfReport.model.js";
import RealEstateReport from "../models/realEstate.model.js";
import { AuthRequest } from "../middleware/auth.middleware.js";
import { releaseReportGroupById, filterCurrentPdfReportArtifacts } from "../service/reportReleaseService.js";

/**
 * Release-manager HTTP boundary for approved reports awaiting publication.
 *
 * Four persistence models feed one client queue, so the formatters below normalize
 * their legacy field differences into a common release-item contract. The release
 * service owns assignment checks and the final state transition.
 */

function userId(req: AuthRequest) {
  return String(req.userId || "");
}

function baseReleaseItem(report: any, reportType: string, title: string, summary = "") {
  // Keep aliases such as `report`, `address`, `status` and `approvalStatus`: clients
  // built against different report families rely on this compatibility projection.
  return {
    _id: report._id,
    report: report.report || report._id,
    reportType,
    title,
    address: title,
    summary,
    createdAt: report.createdAt,
    updatedAt: report.updatedAt,
    status: "approved",
    approvalStatus: "approved",
    release_status: report.release_status || "released",
    release_assigned_to: report.release_assigned_to || null,
    released_at: report.released_at || null,
    contract_no: report.contract_no || report.preview_data?.contract_no || "",
    user: report.user,
  };
}

function formatAssetRelease(report: any) {
  const previewData = report.preview_data || {};
  const title = previewData.client_name || previewData.prepared_for || report.contract_no || "Asset Report";
  return {
    ...baseReleaseItem(report, "Asset", title, report.contract_no || previewData.contract_no || ""),
    preview_files: report.preview_files || {},
    isAssetReport: true,
  };
}

function formatRealEstateRelease(report: any) {
  const previewData = report.preview_data || {};
  const title = previewData.property_details?.address || report.property_details?.address || "Real Estate Report";
  return {
    ...baseReleaseItem(report, "RealEstate", title),
    preview_files: report.preview_files || {},
    isRealEstateReport: true,
  };
}

function formatLotListingRelease(report: any) {
  const previewData = report.preview_data || {};
  const contractNo = previewData.contract_no || report.contract_no || "Lot Listing";
  const location = previewData.location || report.location || "";
  return {
    ...baseReleaseItem(report, "LotListing", location ? `${contractNo} - ${location}` : contractNo, `${contractNo}`),
    preview_files: report.preview_files || {},
    files: report.files || {},
    isLotListing: true,
  };
}

function formatPdfRelease(report: any) {
  return {
    ...baseReleaseItem(report, report.reportType || "Report", report.address || report.filename || "Report", report.fairMarketValue || ""),
    fileType: report.fileType,
    filename: report.filename,
  };
}

export const getAssignedReleases = async (req: AuthRequest, res: Response) => {
  try {
    const id = userId(req);
    if (!id) return res.status(401).json({ message: "Not authenticated" });
    if (!Types.ObjectId.isValid(id)) return res.status(401).json({ message: "Invalid user session" });
    const assignedTo = new Types.ObjectId(id);
    const reviewOwner = req.user?.isReviewAccount === true ? { user: assignedTo } : {};

    // Independent model reads run concurrently to keep queue latency bounded as the
    // number of supported report families grows.
    const [assets, realEstate, lotListings, pdfRows] = await Promise.all([
      AssetReport.find({ ...reviewOwner, status: "approved", release_status: "pending_release", release_assigned_to: assignedTo, is_draft_preview: { $ne: true } } as any)
        .populate("user", "email username companyName")
        .sort({ updatedAt: -1 })
        .lean(),
      RealEstateReport.find({ ...reviewOwner, status: "approved", release_status: "pending_release", release_assigned_to: assignedTo } as any)
        .populate("user", "email username companyName")
        .sort({ updatedAt: -1 })
        .lean(),
      LotListing.find({
        ...reviewOwner,
        status: "approved",
        release_status: "pending_release",
        release_assigned_to: assignedTo,
        auctioneerWorkItem: null,
        is_draft_preview: { $ne: true },
      } as any)
        .populate("user", "email username companyName")
        .sort({ updatedAt: -1 })
        .lean(),
      PdfReport.find({ ...reviewOwner, approvalStatus: "approved", release_status: "pending_release", release_assigned_to: assignedTo } as any)
        .populate("user", "email username companyName")
        .sort({ updatedAt: -1 })
        .lean(),
    ]);

    // PdfReport can contain multiple artifacts for one logical report. Collapse them
    // by group id so a release manager sees one work item and cannot release twice.
    const seenPdfGroups = new Set<string>();
    const pdfItems = (await filterCurrentPdfReportArtifacts(pdfRows || [])).filter((row: any) => {
      const key = String(row.report || row._id);
      if (seenPdfGroups.has(key)) return false;
      seenPdfGroups.add(key);
      return true;
    });

    const items = [
      ...assets.map(formatAssetRelease),
      ...realEstate.map(formatRealEstateRelease),
      ...lotListings.map(formatLotListingRelease),
      ...pdfItems.map(formatPdfRelease),
    ].sort((a: any, b: any) => new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime());

    return res.status(200).json({ items, total: items.length });
  } catch (error) {
    console.error("getAssignedReleases error", error);
    return res.status(500).json({ message: "Failed to load assigned releases" });
  }
};

export const releaseAssignedReport = async (req: AuthRequest, res: Response) => {
  try {
    // Authorization is deliberately delegated with the actor to the service, where
    // it can be checked against the same records participating in the transition.
    const released = await releaseReportGroupById(req.params.id, (req as any).user || { _id: req.userId });
    if (!released) return res.status(404).json({ message: "Report not found" });
    return res.status(200).json({ message: "Report released successfully", data: released });
  } catch (error: any) {
    const statusCode = Number(error?.statusCode || 500);
    // 403 means the actor may not release the item; 409 means its current state no
    // longer permits release. Clients use that distinction to refresh their queue.
    if (statusCode === 403 || statusCode === 409) {
      return res.status(statusCode).json({
        ...(error?.code ? { code: error.code } : {}),
        message: error?.message || "Not authorized to release this report",
        ...(error?.downloadAccess ? { download_access: error.downloadAccess } : {}),
      });
    }
    console.error("releaseAssignedReport error", error);
    return res.status(500).json({ message: error?.message || "Failed to release report" });
  }
};
