import type { Response } from "express";
import mongoose from "mongoose";
import type { AuthRequest } from "../middleware/auth.middleware.js";
import type { AdminAuthRequest } from "../middleware/admin.middleware.js";
import AssetReport from "../models/asset.model.js";
import LotListing from "../models/lotListing.model.js";
import { getInitialPreviewRetryState, retryRetainedInitialPreview } from "../service/initialPreviewRetryService.js";

type Kind = "asset" | "lotListing";
export const initialPreviewRetryController = (kind: Kind | "admin", action: "read" | "retry") => async (req: AuthRequest | AdminAuthRequest, res: Response) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    if (!req.userId) return res.status(401).json({ message: "Not authorized." });
    const reportId = String(req.params.id || "");
    if (!mongoose.isValidObjectId(reportId)) return res.status(400).json({ message: "Invalid report id." });
    const body = req.body;
    if (action === "retry" && (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1 ||
      typeof body.baseRevision !== "string" || !/^[a-f0-9]{64}$/.test(body.baseRevision))) {
      return res.status(400).json({ message: "A current preview recovery revision is required. Refresh and check this report first." });
    }
    let reportType: Kind;
    if (kind === "admin") {
      if ((req.user as any)?.role !== "superadmin") return res.status(403).json({ message: "Superadmin privileges required." });
      const [asset, listing] = await Promise.all([AssetReport.exists({ _id: reportId }), LotListing.exists({ _id: reportId })]);
      if (!asset && !listing) return res.status(404).json({ message: "Report not found." });
      reportType = asset ? "asset" : "lotListing";
    } else reportType = kind;
    const input = { reportType, reportId, actorId: req.userId, scope: kind === "admin" ? "admin" as const : "owner" as const };
    if (action === "read") return res.json({ data: await getInitialPreviewRetryState(input) });
    return res.status(202).json(await retryRetainedInitialPreview({ ...input, baseRevision: body.baseRevision }));
  } catch (error: any) {
    const status = Number(error?.statusCode);
    if ([400, 403, 404, 409, 503].includes(status)) return res.status(status).json({ message: error.message, code: error.code });
    console.error("[InitialPreviewRetry] Unable to complete preview recovery request.");
    return res.status(500).json({ message: "Unable to check preview recovery. Refresh this report before trying again." });
  }
};
