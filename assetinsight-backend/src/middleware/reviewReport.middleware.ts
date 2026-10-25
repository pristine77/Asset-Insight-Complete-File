import type { NextFunction, Response } from "express";
import { Types } from "mongoose";
import type { AuthRequest } from "./auth.middleware.js";
import AssetReport from "../models/asset.model.js";
import LotListing from "../models/lotListing.model.js";
import RealEstateReport from "../models/realEstate.model.js";
import PdfReport from "../models/pdfReport.model.js";
import SalvageReport from "../models/salvage.model.js";
import { isReviewAccount } from "../service/reviewAccountPolicy.js";

/** Legacy/assigned report routes must not let an isolated reviewer reach a
 * customer report, even if an operator accidentally assigns it to that account.
 * Ordinary accounts keep the existing route-specific authorization policy. */
export async function reviewReportOwnerOnly(req: AuthRequest, res: Response, next: NextFunction) {
  if (!isReviewAccount(req.user)) return next();
  const id = String(req.params.id || "");
  if (!Types.ObjectId.isValid(id)) return res.status(404).json({ message: "Report not found" });
  try {
    const groups = await Promise.all([
      AssetReport.find({ _id: id }).select("user").lean(),
      LotListing.find({ _id: id }).select("user").lean(),
      RealEstateReport.find({ _id: id }).select("user").lean(),
      SalvageReport.find({ _id: id }).select("user").lean(),
      PdfReport.find({ $or: [{ _id: id }, { report: id }] } as any).select("user").lean(),
    ]);
    const records = groups.flat();
    if (!records.length || records.some((row: any) => String(row.user) !== String(req.userId))) {
      return res.status(404).json({ message: "Report not found" });
    }
    return next();
  } catch {
    return res.status(500).json({ message: "Could not check report access. Please try again." });
  }
}
