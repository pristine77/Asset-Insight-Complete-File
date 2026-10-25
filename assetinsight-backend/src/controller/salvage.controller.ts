import type { Response } from "express";
import { previewQueueSummary } from "../utils/previewQueueSummary.js";
import type { AuthRequest } from "../middleware/auth.middleware.js";
import { salvageReportUpload } from "../utils/multerStorage.js";
import SalvageReport from "../models/salvage.model.js";
import { cleanupReportJobSourceFiles } from "../utils/reportTempFiles.js";
import { acceptSalvageReport, ownedSalvageReport, requestSalvageGeneration, salvageRow, salvageRows,
  cancelSalvageProcessing, requestSalvageResearch, saveSalvagePreview, SalvageWorkflowError } from "../service/salvageWorkflowService.js";

const userId = (req: AuthRequest) => String(req.userId || (req as any).user?._id || "");
function failure(res: Response, error: unknown) {
  if (error instanceof SalvageWorkflowError) return res.status(error.status).json({ message: error.message, code: error.code });
  console.error("Salvage workflow request failed", error instanceof Error ? error.name : "UnknownError");
  return res.status(500).json({ message: "Unable to process the report. Please retry." });
}
export const uploadMiddleware = salvageReportUpload.array("images", 50);
export const createSalvageReport = async (req: AuthRequest, res: Response) => {
  const images = (req.files || []) as Express.Multer.File[];
  let cleanupSources = true;
  try {
    let details: unknown;
    try { details = JSON.parse(req.body.details || "{}"); } catch { throw new SalvageWorkflowError(400, "Report details must be valid JSON."); }
    // Once persistence starts, an unknown write outcome may have committed the
    // durable outbox. Never remove its originals merely because the ACK was lost.
    cleanupSources = false;
    const result = await acceptSalvageReport(userId(req), details, images);
    cleanupSources = result.reused;
    return res.status(202).json({ message: "Report accepted. Review the preview when analysis is complete.",
      reportId: String(result.report._id), jobId: result.report.legacy_progress_id || result.report.job_id, phase: "processing" });
  } catch (error) {
    if (error instanceof SalvageWorkflowError) cleanupSources = true;
    return failure(res, error);
  }
  finally { if (cleanupSources) await cleanupReportJobSourceFiles(images).catch(() => undefined); }
};
export const getSalvageReports = async (req: AuthRequest, res: Response) => {
  try {
    res.setHeader("Cache-Control", "no-store, private");
    const rows = await salvageRows(await SalvageReport.find({ user: userId(req) as any }).sort({ createdAt: -1 }).lean());
    return res.json({ data: req.query.view === "previews" ? rows.map(row => previewQueueSummary(row, "salvage")) : rows });
  }
  catch (error) { return failure(res, error); }
};
export const getSalvagePreview = async (req: AuthRequest, res: Response) => {
  try { return res.json({ data: await salvageRow(await ownedSalvageReport(req.params.id, userId(req))) }); }
  catch (error) { return failure(res, error); }
};
export const patchSalvagePreview = async (req: AuthRequest, res: Response) => {
  try {
    const report = await ownedSalvageReport(req.params.id, userId(req));
    return res.json({ data: await salvageRow(await saveSalvagePreview(report, req.body?.data, req.body?.baseRevision)) });
  } catch (error) { return failure(res, error); }
};
export const submitSalvagePreview = async (req: AuthRequest, res: Response) => {
  try {
    const report = await requestSalvageGeneration(await ownedSalvageReport(req.params.id, userId(req)), req.body?.baseRevision, req.path.endsWith("/retry"));
    return res.status(202).json({ reportId: String(report._id), jobId: report.job_id, data: await salvageRow(report) });
  } catch (error) { return failure(res, error); }
};
export const researchSalvagePreview = async (req: AuthRequest, res: Response) => {
  try {
    const report = await requestSalvageResearch(await ownedSalvageReport(req.params.id, userId(req)), req.body?.baseRevision, req.body?.client_request_id);
    return res.status(202).json({ reportId: String(report._id), jobId: report.job_id, data: await salvageRow(report) });
  } catch (error) { return failure(res, error); }
};
export const cancelSalvageReport = async (req: AuthRequest, res: Response) => {
  try {
    const report = await cancelSalvageProcessing(await ownedSalvageReport(req.params.id, userId(req)), req.body?.baseRevision, req.body?.jobId);
    return res.json({ data: await salvageRow(report) });
  } catch (error) { return failure(res, error); }
};
export const getSalvageProgress = async (req: AuthRequest, res: Response) => {
  try {
    const report: any = await SalvageReport.findOne({ $or: [{ job_id: req.params.id }, { legacy_progress_id: req.params.id }], user: userId(req) as any }).lean();
    if (!report) throw new SalvageWorkflowError(404, "Progress not found.");
    const row = await salvageRow(report);
    const phase = report.job_status === "cancelled" ? "cancelled" : ["failed", "error"].includes(report.job_status) ? "error" : ["queued", "processing"].includes(report.job_status) ? "processing" : "done";
    return res.json({ id: req.params.id, phase, serverProgress01: row.workflow_progress_percent / 100,
      steps: row.workflow_steps, message: row.workflow_message, preview_available: row.preview_available, can_cancel: row.can_cancel,
      result: { reportId: String(report._id), reportType: "Salvage", status: row.status } });
  } catch (error) { return failure(res, error); }
};
