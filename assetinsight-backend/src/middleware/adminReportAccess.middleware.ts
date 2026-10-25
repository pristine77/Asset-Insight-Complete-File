import { NextFunction, Response } from "express";
import mongoose from "mongoose";
import AssetReport from "../models/asset.model.js";
import LotListing from "../models/lotListing.model.js";
import PdfReport from "../models/pdfReport.model.js";
import RealEstateReport from "../models/realEstate.model.js";
import SalvageReport from "../models/salvage.model.js";
import type { AdminAuthRequest } from "./admin.middleware.js";
import { canInspectAdminReport } from "../utils/adminReportAccessPolicy.js";
type ReportAccessRecord = { status?: string; approval_assigned_to?: unknown };
export async function requireAccessibleAdminReport(
  req: AdminAuthRequest,
  res: Response,
  next: NextFunction
) {
  if (req.user?.role === "superadmin") return next();

  const id = String(req.params.id || "").trim();
  if (!mongoose.Types.ObjectId.isValid(id)) return next();
  const objectId = new mongoose.Types.ObjectId(id);

  try {
    const [asset, realEstate, lotListing, pdfById] = await Promise.all([
      AssetReport.findById(objectId).select("status approval_assigned_to").lean(),
      RealEstateReport.findById(objectId).select("status approval_assigned_to").lean(),
      LotListing.findById(objectId).select("status approval_assigned_to").lean(),
      PdfReport.findById(objectId)
        .select("approvalStatus approval_assigned_to")
        .lean(),
    ]);

    const directRecord =
      asset ||
      realEstate ||
      lotListing ||
      (pdfById
        ? {
            status: (pdfById as any).approvalStatus,
            approval_assigned_to: (pdfById as any).approval_assigned_to,
          }
        : null);

    if (directRecord) {
      if (
        canInspectAdminReport(directRecord as ReportAccessRecord, req.userId)
      ) {
        return next();
      }
      return res
        .status(403)
        .json({ message: "Superadmin privileges required" });
    }

    const pdfByParent = await PdfReport.findOne({ report: objectId } as any)
      .select("approvalStatus approval_assigned_to")
      .lean();
    if (pdfByParent) {
      const record = {
        status: (pdfByParent as any).approvalStatus,
        approval_assigned_to: (pdfByParent as any).approval_assigned_to,
      };
      if (
        canInspectAdminReport(record, req.userId)
      ) {
        return next();
      }
      return res
        .status(403)
        .json({ message: "Superadmin privileges required" });
    }

    // A bare salvage record has no approval state of its own. Its generated
    // PdfReport carries that state, so without one it is preview-only.
    const salvage = await SalvageReport.exists({ _id: objectId });
    if (salvage) {
      return res
        .status(403)
        .json({ message: "Superadmin privileges required" });
    }

    return next();
  } catch {
    return res.status(500).json({ message: "Failed to verify report access" });
  }
}
