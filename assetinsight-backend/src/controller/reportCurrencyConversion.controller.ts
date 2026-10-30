import mongoose from "mongoose";
import type { Response } from "express";
import AssetReport from "../models/asset.model.js";
import LotListing from "../models/lotListing.model.js";
import { convertReportPreviewCurrency, currencyBaseRevision, ReportCurrencyConversionError, type CurrencyReportKind } from "../service/reportCurrencyConversionService.js";

const quota = new Map<string, { since: number; count: number }>();
export function resetCurrencyConversionQuotaForTests() { quota.clear(); }
function consumeQuota(userId: string) {
  const now = Date.now(), old = quota.get(userId);
  if (old && now - old.since < 60_000 && old.count >= 6) throw new ReportCurrencyConversionError("Too many currency lookups. Wait a minute and try again.", 429, "CURRENCY_RATE_LIMIT");
  quota.set(userId, old && now - old.since < 60_000 ? { ...old, count: old.count + 1 } : { since: now, count: 1 });
  if (quota.size > 10_000) for (const [key, value] of quota) if (now - value.since >= 60_000) quota.delete(key);
}
function generating(report: any) {
  return report.files_generating === true || report.files_regenerating === true || ["queued", "processing"].includes(String(report.job_status || ""));
}
function stamp(report: any) { return JSON.stringify({ updatedAt: report.updatedAt, pvRevision: report.proposal_valuation_revision || 0, status: report.status, owner: String(report.user), assigned: String(report.approval_assigned_to || "") }); }
async function accessible(id: string, userId: string, kind?: CurrencyReportKind) {
  if (kind) {
    const Model: any = kind === "asset" ? AssetReport : LotListing;
    const report = await Model.findOne({ _id: id, user: userId });
    return report ? { report, kind } : null;
  }
  const [asset, listing] = await Promise.all([
    AssetReport.findOne({ _id: new mongoose.Types.ObjectId(id), status: "pending_approval", approval_assigned_to: new mongoose.Types.ObjectId(userId), is_draft_preview: { $ne: true } } as any),
    LotListing.findOne({ _id: new mongoose.Types.ObjectId(id), approval_assigned_to: new mongoose.Types.ObjectId(userId), auctioneerWorkItem: null, is_draft_preview: { $ne: true }, $or: [{ status: "pending_approval" }, { status: { $in: ["processing", "error"] }, generation_target_status: { $in: ["pending_approval", "approved"] } }] } as any),
  ]);
  return asset ? { report: asset, kind: "asset" as const } : listing ? { report: listing, kind: "lotListing" as const } : null;
}
function controller(kind?: CurrencyReportKind) {
  return async (req: any, res: Response) => {
    res.setHeader("Cache-Control", "no-store, private");
    try {
      if (!req.userId) return res.status(401).json({ message: "Unauthorized" });
      const id = String(req.params.id || ""), actor = String(req.userId);
      if (!mongoose.isValidObjectId(id)) return res.status(400).json({ message: "Invalid report id." });
      const found = await accessible(id, actor, kind);
      if (!found) return res.status(404).json({ message: "Editable report not found." });
      if (!["preview", "declined", "pending_approval", "approved", "error"].includes(String(found.report.status))) throw new ReportCurrencyConversionError("This report cannot be edited in its current status.", 409, "CURRENCY_REPORT_CHANGED");
      if (generating(found.report)) throw new ReportCurrencyConversionError("Wait for this report to finish processing before converting its currency.", 409, "CURRENCY_GENERATION_ACTIVE");
      if (req.body?.preview_data?._currency_base_revision !== currencyBaseRevision(found.report)) throw new ReportCurrencyConversionError("The report changed since this preview was opened. Refresh before converting its currency.", 409, "CURRENCY_REPORT_CHANGED");
      consumeQuota(actor);
      const result = await convertReportPreviewCurrency({ report: found.report, kind: found.kind, previewData: req.body?.preview_data, targetCurrency: req.body?.targetCurrency });
      // Web search is asynchronous. A reassignment/new edit during the lookup
      // invalidates its result rather than returning a stale editable snapshot.
      const current = await accessible(id, actor, kind);
      if (!current || generating(current.report) || stamp(current.report) !== stamp(found.report)) throw new ReportCurrencyConversionError("The report changed during the currency lookup. Refresh and convert again.", 409, "CURRENCY_REPORT_CHANGED");
      return res.json({ data: result });
    } catch (error) {
      if (error instanceof ReportCurrencyConversionError) {
        if (error.statusCode === 429) res.setHeader("Retry-After", "60");
        return res.status(error.statusCode).json({ message: error.message, code: error.code });
      }
      return res.status(503).json({ message: "Currency conversion is unavailable. Your report is unchanged.", code: "CURRENCY_CONVERSION_UNAVAILABLE" });
    }
  };
}
export const convertAssetPreviewCurrency = controller("asset");
export const convertLotListingPreviewCurrency = controller("lotListing");
export const convertAssignedPreviewCurrency = controller();
