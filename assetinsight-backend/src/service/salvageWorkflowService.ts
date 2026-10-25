import { createHash, randomUUID } from "node:crypto";
import mongoose from "mongoose";
import SalvageReport from "../models/salvage.model.js";
import PdfReport from "../models/pdfReport.model.js";
import ReportJob from "../models/reportJob.model.js";
import { salvageWorkflowSteps } from "./salvageProgress.js";
import { presentSalvageSnapshot, salvageSystemText } from "./salvagePresentation.js";
import { normalizeSalvageReportData, salvageNumber } from "./salvageReportData.js";
import { getReportDownloadAccess, isCurrentSalvagePdfArtifact } from "./reportReleaseService.js";
import { hasRequiredReportFiles } from "../utils/reportFileState.js";
import { buildReportJobOutbox, ensureReportJobOutbox } from "../utils/reportJobMongoQueue.js";
import { serializeMulterFiles } from "../utils/multerFileSerialization.js";
import { readMulterFileBuffer } from "../utils/reportTempFiles.js";
import { isSalvageAssessmentV2, normalizeSalvageAssessmentInputs, projectSalvageAssessmentLegacyFields, refreshSalvageAssessment } from "./salvageAssessment.js";
import { normalizeSalvageVehicleOverrides, validateSalvageVehicleOverrides } from "./salvageVehicleDetails.js";
import { normalizeSalvageReportContext, validateSalvageReportContext } from "./salvageReportEnrichment.js";

export const SALVAGE_EDITABLE_FIELDS = [
  "report_date", "file_number", "date_received", "claim_number", "policy_number", "date_of_loss",
  "reported_loss_type", "appraiser_name", "appraiser_phone", "appraiser_email", "adjuster_name",
  "insured_name", "company_name", "company_address", "cause_of_loss_summary", "appraiser_comments",
  "next_report_due", "item_type", "year", "make", "item_model", "vin", "language", "currency",
  "item_condition", "damage_description", "inspection_comments", "is_repairable", "repair_facility",
  "repair_facility_comments", "actual_cash_value", "replacement_cost", "recommended_reserve",
  "repair_items", "labour_breakdown", "labour_rate_default", "repair_estimate", "procurement_notes",
  "assumptions", "safety_concerns", "priority_level", "specialty_data", "valuation", "assessment_inputs", "report_context",
] as const;
const structured = new Set(["repair_items", "labour_breakdown", "repair_estimate", "specialty_data", "valuation", "assessment_inputs", "report_context"]);
const numeric = new Set(["actual_cash_value", "replacement_cost", "recommended_reserve", "labour_rate_default"]);
export class SalvageWorkflowError extends Error {
  constructor(public status: number, message: string, public code = "SALVAGE_WORKFLOW_ERROR") { super(message); }
}
function validateMoney(value: unknown, field: string) {
  if (value === undefined || value === null || value === "") return;
  const amount = salvageNumber(value);
  if (amount === undefined || amount < 0) throw new SalvageWorkflowError(400, `Invalid ${field}: use a nonnegative number.`);
}
function validateRepairRows(value: unknown, field: string) {
  if (!Array.isArray(value) || value.length > 500) throw new SalvageWorkflowError(400, `Invalid ${field}.`);
  for (const line of value) {
    if (!line || typeof line !== "object" || Array.isArray(line)) throw new SalvageWorkflowError(400, `Invalid ${field} row.`);
    for (const key of ["quantity", "unit_price", "hours", "rate_per_hour", "line_total", "lead_time_days"]) validateMoney(line[key], `${field} ${key}`);
  }
}
function validateFiniteValues(value: unknown) {
  if (typeof value === "number" && !Number.isFinite(value)) throw new SalvageWorkflowError(400, "Repair values are too large to calculate safely.");
  if (value && typeof value === "object") for (const child of Object.values(value)) validateFiniteValues(child);
}
function validateAssessmentInputs(value: Record<string, any>) {
  if (Object.prototype.hasOwnProperty.call(value, "vehicleOverrides")) {
    const validation = validateSalvageVehicleOverrides(value.vehicleOverrides);
    if (!validation.valid) throw new SalvageWorkflowError(400, validation.errors.join(" "));
  }
  const normalized = normalizeSalvageAssessmentInputs(value);
  for (const field of ["year", "vin", "province", "brandProvince", "effectiveDate", "odometer", "odometerUnit"] as const) {
    if (value[field] !== undefined && value[field] !== null && value[field] !== "" && normalized[field] === null) {
      throw new SalvageWorkflowError(400, `Invalid assessment ${field}.`);
    }
  }
  const limits: Record<string, number> = { repairItems: 300, labourItems: 300, charges: 50, suppliedComparables: 20, suppliedReferences: 50 };
  for (const [field, limit] of Object.entries(limits)) {
    if (value[field] === undefined) continue;
    if (!Array.isArray(value[field]) || value[field].length > limit) throw new SalvageWorkflowError(400, `Invalid assessment ${field}; maximum ${limit} entries.`);
    for (const row of value[field]) {
      if (!row || typeof row !== "object" || Array.isArray(row)) throw new SalvageWorkflowError(400, `Invalid assessment ${field} entry.`);
      for (const money of ["quantity", "unitPrice", "hours", "rate", "amount", "price", "odometer"]) validateMoney(row[money], `${field} ${money}`);
    }
  }
  for (const field of ["sellerCosts", "overrides"]) {
    if (value[field] === undefined) continue;
    if (!value[field] || typeof value[field] !== "object" || Array.isArray(value[field])) throw new SalvageWorkflowError(400, `Invalid assessment ${field}.`);
    for (const row of Object.values(value[field]) as any[]) {
      if (row === null) continue;
      if (!row || typeof row !== "object" || Array.isArray(row)) throw new SalvageWorkflowError(400, `Invalid assessment ${field} entry.`);
      validateMoney(row.amount, `${field} amount`);
    }
  }
  return normalized;
}
export function editableSalvageData(input: unknown): Record<string, any> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new SalvageWorkflowError(400, "Report details must be an object.");
  const output: Record<string, any> = {};
  for (const key of SALVAGE_EDITABLE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
    const value = (input as any)[key] instanceof Date ? (input as any)[key].toISOString() : (input as any)[key];
    if (value === undefined) continue;
    if (structured.has(key)) {
      if (["repair_items", "labour_breakdown"].includes(key)) validateRepairRows(value, key);
      else if (!value || typeof value !== "object" || Array.isArray(value)) throw new SalvageWorkflowError(400, `Invalid ${key}.`);
      if (key === "repair_estimate") {
        for (const field of ["parts", "labour", "parts_subtotal", "labour_total", "labour_rate_default", "shop_supplies", "miscellaneous", "taxes", "less_betterment", "total"]) validateMoney(value[field], `repair_estimate ${field}`);
        for (const field of ["parts_items", "labour_breakdown"]) if (value[field] !== undefined) validateRepairRows(value[field], field);
      }
      if (key === "report_context") {
        const error = validateSalvageReportContext(value);
        if (error) throw new SalvageWorkflowError(400, error);
        output[key] = normalizeSalvageReportContext(value);
      } else if (key === "assessment_inputs") {
        if (JSON.stringify(value).length > 300000) throw new SalvageWorkflowError(400, "Assessment inputs are too large.");
        try { output[key] = validateAssessmentInputs(value); }
        catch (error) { throw new SalvageWorkflowError(400, error instanceof Error ? error.message : "Invalid assessment inputs."); }
      } else output[key] = value;
    } else if (numeric.has(key)) {
      if (value === null && ((input as any).assessment_inputs || isSalvageAssessmentV2((input as any).assessment))) {
        output[key] = null;
        continue;
      }
      const amount = value === "" || value === null ? 0 : salvageNumber(value);
      if (amount === undefined || amount < 0) throw new SalvageWorkflowError(400, `Invalid ${key}: use a nonnegative number.`);
      output[key] = amount;
    } else {
      if (value !== null && !["string", "number", "boolean"].includes(typeof value)) throw new SalvageWorkflowError(400, `Invalid ${key}.`);
      output[key] = value == null ? "" : String(value);
      if (output[key].length > 20000) throw new SalvageWorkflowError(400, `${key} is too long.`);
    }
  }
  validateFiniteValues(normalizeSalvageReportData(output));
  return output;
}
export const salvageBusy = (report: any): boolean => ["queued", "processing"].includes(report.job_status) || report.files_generating === true;
export const salvageSnapshot = (report: any): Record<string, any> => {
  const source = report.preview_data || report;
  // Do not embed workflow internals, artifact URLs or tokens in an editable snapshot.
  const editable = Object.fromEntries(SALVAGE_EDITABLE_FIELDS.filter(key => Object.prototype.hasOwnProperty.call(source, key)).map(key => [key, source[key]]));
  const snapshot = normalizeSalvageReportData({ ...editable, imageUrls: report.imageUrls || source.imageUrls || [],
    aiExtractedDetails: source.aiExtractedDetails, comparableItems: source.comparableItems || report.comparableItems || [],
    assessment: source.assessment || report.assessment,
    analysis_warning: source.analysis_warning || report.analysis_warning, analysis_model: source.analysis_model || report.analysis_model,
    estimate_warning: source.estimate_warning, replacement_cost_references: source.replacement_cost_references,
    report_history: { revision: Number(report.revision || 0), events: (report.assessment_edit_history || []).map((event: any) => ({
      revision: event.revision, at: event.at instanceof Date ? event.at.toISOString() : event.at,
      changedFields: event.changedFields || [],
    })) } });
  return isSalvageAssessmentV2(snapshot.assessment) ? { ...snapshot, ...projectSalvageAssessmentLegacyFields(snapshot.assessment) } : snapshot;
};
export async function ownedSalvageReport(id: unknown, userId: unknown): Promise<any> {
  if (!mongoose.isValidObjectId(id)) throw new SalvageWorkflowError(404, "Report not found.");
  const report = await SalvageReport.findOne({ _id: id, user: userId } as any).select("+research_requests +assessment_edit_history").lean();
  if (!report) throw new SalvageWorkflowError(404, "Report not found.");
  return report;
}
export async function salvageRows(reports: any[]): Promise<any[]> {
  const artifacts = await PdfReport.find({ report: { $in: reports.map(r => r._id) }, reportType: "Salvage" }).lean();
  return reports.map(report => {
    const siblings = artifacts.filter((p: any) => String(p.report) === String(report._id) && isCurrentSalvagePdfArtifact(p, report));
    const busy = salvageBusy(report);
    const cancelled = report.job_status === "cancelled";
    const previewAvailable = Boolean(report.preview_data) || !report.workflow_version;
    const publicSnapshot = presentSalvageSnapshot(salvageSnapshot(report));
    let status = ["error", "failed"].includes(report.job_status) ? "error" : report.status || "preview";
    if (!busy && !["preview", "processing", "error"].includes(status) || !report.workflow_version) {
      if (siblings.some(p => p.approvalStatus === "rejected")) status = "declined";
      else if (siblings.length && siblings.every(p => p.approvalStatus === "approved")) status = "approved";
      else if (siblings.length) status = "pending_approval";
    }
    const ready = !busy && !cancelled && !report.files_stale && (report.workflow_version ? hasRequiredReportFiles("salvage", report.files) : siblings.length >= 4);
    const access = siblings.length ? getReportDownloadAccess(siblings[0]) : getReportDownloadAccess({ status: "pending_approval" });
    const downloadable = ready && siblings.length >= 4 && siblings.every(p => getReportDownloadAccess(p).allowed);
    const files: Record<string, string> = {};
    if (downloadable) for (const p of siblings) if (p.fileType && ["pdf", "docx", "xlsx", "images"].includes(p.fileType)) files[p.fileType] = String(p._id);
    const stage = cancelled ? "stopped" : busy ? report.generation_kind === "files" ? "generating_files" : "preparing_preview" : status === "error" ? "error" : status === "preview" ? "preview_ready" : downloadable ? "ready" : status === "approved" ? "awaiting_release" : "awaiting_approval";
    const messages: Record<string, string> = { preparing_preview: "Analyzing your report. You can return here while processing continues.", generating_files: "Generating PDF, Word, Excel and the original photo ZIP from your saved preview.", error: "Processing failed. Your saved details are retained; retry to continue.", preview_ready: "Review and save your details, then submit to generate files for approval.", awaiting_approval: "Files are ready and waiting for approval.", awaiting_release: "Approved and waiting for release.", ready: "All report files are ready to download." };
    return { _id: String(report._id), reportId: String(report._id), reportType: "Salvage", file_number: report.file_number,
      status: cancelled ? "cancelled" : status, revision: Number(report.revision || 0), currency: report.currency, valuation: publicSnapshot.valuation,
      imageUrls: report.imageUrls || [], preview_data: publicSnapshot, createdAt: report.createdAt, updatedAt: report.updatedAt,
      generation_kind: report.generation_kind, generation_state: cancelled ? "cancelled" : busy ? report.job_status || "processing" : status === "error" ? "error" : "ready",
      preview_available: previewAvailable, can_cancel: busy && Boolean(report.job_id), workflow_steps: salvageWorkflowSteps(report),
      workflow_stage: stage, workflow_message: cancelled ? "Processing stopped. Saved details and photos are retained. You can retry, or edit an available preview and resubmit." : busy && report.generation_progress?.message ? salvageSystemText(report.generation_progress.message) : messages[stage], workflow_progress_percent: busy || cancelled || status === "error" ? Number(report.generation_progress?.percent || 0) : 100,
      files_ready: ready, files_generating: busy && report.generation_kind === "files", job_status: report.job_status, job_id: report.job_id,
      job_error: salvageSystemText(report.job_error), downloadable, download_access: downloadable ? access : { ...access, allowed: false }, files };
  });
}
export async function salvageRow(report: any) { return (await salvageRows([report]))[0]; }

function outbox(reportId: string, jobId: string, kind: "preview" | "files", revision: number) {
  return buildReportJobOutbox({ type: kind === "preview" ? "salvage-preview" : "salvage-files", reportId, progressId: jobId,
    idempotencyKey: jobId, token: jobId, payload: { generationToken: jobId, revision, notifyOwnerOnFailure: false }, maxAttempts: 3 });
}
export async function dispatchSalvage(reportId: string, token?: string) {
  // Acceptance is the persisted outbox, not this best-effort dispatch. Workers recover it after restart.
  try { await ensureReportJobOutbox("salvage", reportId, token); } catch { console.warn("Salvage job dispatch deferred to durable outbox sweep", reportId); }
}
export async function acceptSalvageReport(userId: string, raw: any, images: Express.Multer.File[]): Promise<{ report: any; reused: boolean }> {
  if (images.length > 50) throw new SalvageWorkflowError(400, "Salvage reports support at most 50 photos.");
  const details = editableSalvageData(raw);
  const suppliedId = raw.client_submission_id || raw.progress_id || raw.progressId || raw.job_id;
  if (suppliedId !== undefined && (typeof suppliedId !== "string" || suppliedId.length > 200 || !suppliedId.trim())) throw new SalvageWorkflowError(400, "Invalid submission ID.");
  const clientId = suppliedId || randomUUID();
  const legacyProgressId = raw.progress_id || raw.progressId || raw.job_id;
  if (legacyProgressId !== undefined && (typeof legacyProgressId !== "string" || legacyProgressId.length > 200)) throw new SalvageWorkflowError(400, "Invalid progress ID.");
  const id = createHash("sha256").update(`salvage:${userId}:${clientId}`).digest("hex").slice(0, 24);
  const contentHashes = [];
  for (const file of images) contentHashes.push(createHash("sha256").update(await readMulterFileBuffer(file)).digest("hex"));
  const fingerprint = createHash("sha256").update(JSON.stringify({ details, images: contentHashes })).digest("hex");
  const existing: any = await SalvageReport.findById(id).select("+submission_fingerprint").lean();
  if (existing) {
    if (existing.submission_fingerprint !== fingerprint) throw new SalvageWorkflowError(409, "This submission ID was already used for different report details. Start a new report.");
    await dispatchSalvage(id);
    return { report: existing, reused: true };
  }
  const jobId = `salvage-${id}-${randomUUID()}`;
  const report = new SalvageReport({ ...details, _id: id, user: userId, workflow_version: 1, status: "processing", revision: 0,
    source_files: serializeMulterFiles(images), submission_fingerprint: fingerprint, client_submission_id: clientId,
    legacy_progress_id: legacyProgressId,
    imageUrls: [], job_id: jobId, job_status: "queued", generation_kind: "preview", queued_at: new Date(),
    report_job_outbox: outbox(id, jobId, "preview", 0) });
  try { await report.save(); } catch (error: any) {
    if (error?.code === 11000) {
      const winner: any = await SalvageReport.findById(id).select("+submission_fingerprint").lean();
      if (winner?.submission_fingerprint === fingerprint) return { report: winner, reused: true };
      throw new SalvageWorkflowError(409, "Submission details conflict with an existing request.");
    }
    if (error?.name === "ValidationError") throw new SalvageWorkflowError(400, "Required report details are missing or invalid.");
    throw error;
  }
  await dispatchSalvage(id, jobId);
  return { report: report.toObject(), reused: false };
}
function requireRevision(report: any, baseRevision: unknown) {
  if (!Number.isInteger(baseRevision) || baseRevision !== Number(report.revision || 0)) throw new SalvageWorkflowError(409, "This report changed. Reload the latest preview before saving or submitting.", "SALVAGE_REVISION_CONFLICT");
}
function revisionFilter(report: any) {
  return report.revision === undefined ? { $or: [{ revision: { $exists: false } }, { revision: 0 }] } : { revision: report.revision };
}
const assessmentSubjectFields: Record<string, string> = {
  year: "year", make: "make", item_model: "model", vin: "vin", item_condition: "condition",
  damage_description: "damageDescription", reported_loss_type: "lossType",
};
function mergeAssessmentEdits(current: Record<string, any>, data: unknown): Record<string, any> {
  if (!data || typeof data !== "object" || Array.isArray(data)) return editableSalvageData(data);
  const raw = { ...data } as Record<string, any>;
  if (Object.prototype.hasOwnProperty.call(raw, "report_context")) {
    const error = validateSalvageReportContext(raw.report_context);
    if (error) throw new SalvageWorkflowError(400, error);
    raw.report_context = { ...normalizeSalvageReportContext(current.report_context), ...normalizeSalvageReportContext(raw.report_context) };
  }
  const ownsInputs = Object.prototype.hasOwnProperty.call(raw, "assessment_inputs");
  if (ownsInputs && (!raw.assessment_inputs || typeof raw.assessment_inputs !== "object" || Array.isArray(raw.assessment_inputs))) {
    throw new SalvageWorkflowError(400, "Invalid assessment_inputs.");
  }
  const enterprise = isSalvageAssessmentV2(current.assessment) || ownsInputs || Boolean(current.assessment_inputs);
  if (!enterprise) return editableSalvageData(raw);
  const suppliedInputs = ownsInputs ? { ...raw.assessment_inputs } : {};
  if (Object.prototype.hasOwnProperty.call(suppliedInputs, "vehicleOverrides")) {
    const validation = validateSalvageVehicleOverrides(suppliedInputs.vehicleOverrides);
    if (!validation.valid) throw new SalvageWorkflowError(400, validation.errors.join(" "));
    suppliedInputs.vehicleOverrides = normalizeSalvageVehicleOverrides(suppliedInputs.vehicleOverrides);
  }
  const changedLegacy = (key: string): boolean => {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) return false;
    if (numeric.has(key)) {
      const before = current[key] === null || current[key] === "" ? null : salvageNumber(current[key]);
      const after = raw[key] === null || raw[key] === "" ? null : salvageNumber(raw[key]);
      return before !== after;
    }
    return JSON.stringify(raw[key]) !== JSON.stringify(current[key]);
  };
  // V2 headline values are calculations, not a second editable source of truth.
  // Older clients may echo unchanged legacy fields; only conflicting edits fail.
  for (const key of ["actual_cash_value", "replacement_cost", "recommended_reserve", "valuation", "repair_estimate", "labour_rate_default"]) {
    if (changedLegacy(key)) throw new SalvageWorkflowError(400,
      `The Canadian assessment calculates ${key}. Edit assessment inputs or enter an appraiser override with its rationale instead.`, "SALVAGE_ASSESSMENT_INPUT_REQUIRED");
  }
  const previousInputs = current.assessment_inputs || current.assessment?.inputs || {};
  const inputs = { ...previousInputs, ...suppliedInputs };
  const canonicalWins = (canonical: string, legacy: string): boolean =>
    Object.prototype.hasOwnProperty.call(suppliedInputs, canonical) &&
    (JSON.stringify(suppliedInputs[canonical]) !== JSON.stringify(previousInputs[canonical]) || !changedLegacy(legacy));
  for (const nested of ["sellerCosts", "overrides", "vehicleOverrides"]) {
    if (suppliedInputs[nested] && typeof suppliedInputs[nested] === "object" && !Array.isArray(suppliedInputs[nested])) {
      inputs[nested] = { ...previousInputs[nested], ...suppliedInputs[nested] };
    }
  }
  for (const [legacy, canonical] of Object.entries(assessmentSubjectFields)) {
    // Full-form saves can echo untouched canonical inputs beside a legacy edit.
    // Only an actually changed canonical value wins over a changed legacy alias.
    if (canonicalWins(canonical, legacy)) raw[legacy] = suppliedInputs[canonical] ?? "";
    else if (Object.prototype.hasOwnProperty.call(raw, legacy)) inputs[canonical] = raw[legacy];
  }
  if (current.assessment?.vehicleDetails?.schemaVersion === 1) {
    // Older preview clients can still edit scalar aliases. Only a real change
    // becomes an override; unchanged form echoes must never claim AI evidence.
    const vehicleOverrides = { ...inputs.vehicleOverrides };
    const normalizedInputs = normalizeSalvageAssessmentInputs(inputs);
    const normalizedPrevious = normalizeSalvageAssessmentInputs(previousInputs);
    for (const key of ["year", "make", "model", "trim", "powertrain", "vin", "odometer", "odometerUnit"]) {
      const explicitOverrideChanged = Object.prototype.hasOwnProperty.call(suppliedInputs.vehicleOverrides || {}, key)
        && JSON.stringify(suppliedInputs.vehicleOverrides[key]) !== JSON.stringify(previousInputs.vehicleOverrides?.[key]);
      if (!explicitOverrideChanged
        && JSON.stringify(normalizedInputs[key as keyof typeof normalizedInputs]) !== JSON.stringify(normalizedPrevious[key as keyof typeof normalizedPrevious])) {
        vehicleOverrides[key] = inputs[key] === null || inputs[key] === "" ? null : String(inputs[key]);
      }
    }
    inputs.vehicleOverrides = vehicleOverrides;
  }
  if (canonicalWins("repairItems", "repair_items")) {
    raw.repair_items = Array.isArray(suppliedInputs.repairItems) ? suppliedInputs.repairItems.map((row: any) => ({
      name: row.description, quantity: row.quantity, unit_price: row.unitPrice, notes: row.appraiserReason,
    })) : suppliedInputs.repairItems;
  } else if (changedLegacy("repair_items")) {
    inputs.repairItems = normalizeSalvageAssessmentInputs({ repair_items: raw.repair_items }).repairItems;
  }
  if (canonicalWins("labourItems", "labour_breakdown")) {
    raw.labour_breakdown = Array.isArray(suppliedInputs.labourItems) ? suppliedInputs.labourItems.map((row: any) => ({
      task: row.description, hours: row.hours, rate_per_hour: row.rate, notes: row.appraiserReason,
    })) : suppliedInputs.labourItems;
  } else if (changedLegacy("labour_breakdown")) {
    inputs.labourItems = normalizeSalvageAssessmentInputs({ labour_breakdown: raw.labour_breakdown }).labourItems;
  }
  raw.assessment_inputs = inputs;
  raw.currency = "CAD";
  return editableSalvageData(raw);
}
function assessmentEditAudit(report: any, before: Record<string, any>, after: Record<string, any>) {
  const changedFields = SALVAGE_EDITABLE_FIELDS.filter(key => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
  const oldInputs = before.assessment_inputs || before.assessment?.inputs || {};
  const newInputs = after.assessment_inputs || {};
  const scalarChanges = Object.fromEntries(Object.keys(newInputs).filter(key => (newInputs[key] === null || typeof newInputs[key] !== "object")
    && JSON.stringify(oldInputs[key]) !== JSON.stringify(newInputs[key])).map(key => [key, { before: oldInputs[key] ?? null, after: newInputs[key] }]));
  return { revision: Number(report.revision || 0) + 1, actor: report.user, at: new Date(), changedFields,
    scalarChanges, overrides: { before: oldInputs.overrides || null, after: newInputs.overrides || null },
    vehicleOverrides: { before: oldInputs.vehicleOverrides || null, after: newInputs.vehicleOverrides || null },
    reportContext: { before: before.report_context || {}, after: after.report_context || {} },
    beforeHash: createHash("sha256").update(JSON.stringify(oldInputs)).digest("hex"),
    afterHash: createHash("sha256").update(JSON.stringify(newInputs)).digest("hex") };
}
export async function saveSalvagePreview(report: any, data: unknown, baseRevision: unknown): Promise<any> {
  requireRevision(report, baseRevision);
  if (salvageBusy(report)) throw new SalvageWorkflowError(409, "Wait for processing to finish before editing.");
  if (report.workflow_version && !report.preview_data) throw new SalvageWorkflowError(409, "Retry initial analysis before editing this report.");
  const before = salvageSnapshot(report);
  let snapshot = normalizeSalvageReportData({ ...before, ...mergeAssessmentEdits(before, data) });
  if (isSalvageAssessmentV2(before.assessment)) {
    snapshot.assessment = refreshSalvageAssessment(before.assessment, snapshot.assessment_inputs || before.assessment.inputs);
    snapshot.assessment_inputs = snapshot.assessment.inputs;
    Object.assign(snapshot, projectSalvageAssessmentLegacyFields(snapshot.assessment));
  }
  // Re-project only after recalculating the assessment. Narrative never changes its arithmetic.
  snapshot = normalizeSalvageReportData(snapshot);
  const audit = assessmentEditAudit(report, before, snapshot);
  snapshot.report_history = { revision: Number(report.revision || 0) + 1,
    events: [...(before.report_history?.events || []), { revision: audit.revision, at: audit.at.toISOString(), changedFields: audit.changedFields }] };
  snapshot = normalizeSalvageReportData(snapshot);
  validateFiniteValues(snapshot);
  const modelCheck = new SalvageReport({ ...report, ...editableSalvageData(snapshot) });
  const validation = modelCheck.validateSync();
  if (validation) throw new SalvageWorkflowError(400, "Required report details are missing or invalid.");
  const saved = await SalvageReport.findOneAndUpdate({ _id: report._id, ...revisionFilter(report), job_id: report.job_id,
    job_status: { $nin: ["queued", "processing"] }, files_generating: { $ne: true } },
  { $set: { ...editableSalvageData(snapshot), assessment: snapshot.assessment, workflow_version: 1, preview_data: snapshot, status: "preview", files_stale: true, job_status: "done", job_error: "" }, $inc: { revision: 1 },
    $push: { assessment_edit_history: audit } }, { new: true }).select("+assessment_edit_history").lean();
  if (!saved) throw new SalvageWorkflowError(409, "This report changed. Reload before saving.", "SALVAGE_REVISION_CONFLICT");
  return saved;
}
export async function requestSalvageGeneration(report: any, baseRevision: unknown, retry = false): Promise<any> {
  if (!retry || report.job_status === "cancelled" || baseRevision !== undefined) requireRevision(report, baseRevision);
  if (salvageBusy(report)) { await dispatchSalvage(String(report._id)); return report; }
  if (retry && !["failed", "error", "cancelled"].includes(report.job_status) && report.status !== "error") throw new SalvageWorkflowError(409, "Only failed or stopped processing can be retried.");
  const kind = retry && report.generation_kind === "preview" ? "preview" : "files";
  if (kind === "files" && !report.preview_data && report.workflow_version) throw new SalvageWorkflowError(409, "The preview is not ready yet.");
  // An exact repeat after successful generation is a read, not a new set of files.
  if (!retry && !report.files_stale && hasRequiredReportFiles("salvage", report.files)) return report;
  const jobId = `salvage-${report._id}-${randomUUID()}`;
  const updated = await SalvageReport.findOneAndUpdate({ _id: report._id, ...revisionFilter(report), job_id: report.job_id,
    job_status: { $nin: ["queued", "processing"] }, files_generating: { $ne: true } }, { $set: {
      workflow_version: 1, status: kind === "preview" ? "processing" : "preview", generation_kind: kind, generation_revision: Number(report.revision || 0),
      preview_data: kind === "files" ? salvageSnapshot(report) : report.preview_data, job_id: jobId, job_status: "queued", job_error: "",
      generation_attempt: 0,
      files_generating: kind === "files", files_stale: true, queued_at: new Date(), generation_progress: { percent: 0 },
      report_job_outbox: outbox(String(report._id), jobId, kind, Number(report.revision || 0)),
    }, $unset: { job_execution_token: 1 } }, { new: true }).lean();
  if (!updated) throw new SalvageWorkflowError(409, "This report changed. Reload before submitting.", "SALVAGE_REVISION_CONFLICT");
  await dispatchSalvage(String(report._id), jobId);
  return updated;
}

/** Fence the exact run first. Queue cancellation is secondary to this durable publication boundary. */
export async function cancelSalvageProcessing(report: any, baseRevision: unknown, jobId: unknown): Promise<any> {
  requireRevision(report, baseRevision);
  if (typeof jobId !== "string" || !jobId || jobId !== report.job_id) {
    throw new SalvageWorkflowError(409, "This processing run changed. Reload before stopping it.", "SALVAGE_GENERATION_CONFLICT");
  }
  const cancelQueue = async () => {
    await ReportJob.updateMany({ reportId: String(report._id), type: { $in: ["salvage-preview", "salvage-files"] },
      "payload.generationToken": jobId, status: { $in: ["queued", "processing"] } },
    { $set: { status: "cancelled", completedAt: new Date(), lastError: "Processing stopped by the report owner." },
      $unset: { lockedBy: 1, executionToken: 1, leaseUntil: 1, dedupeKey: 1 } });
  };
  if (report.job_status === "cancelled") { await cancelQueue(); return report; }
  if (!salvageBusy(report)) throw new SalvageWorkflowError(409, "Processing has already finished. Reload to see the current report.", "SALVAGE_NOT_PROCESSING");
  const updated = await SalvageReport.findOneAndUpdate({ _id: report._id, user: report.user, job_id: jobId,
    $and: [revisionFilter(report), { $or: [{ job_status: { $in: ["queued", "processing"] } }, { files_generating: true }] }] },
  { $set: { job_status: "cancelled", status: report.preview_data ? "preview" : "error",
      // A tombstone blocks worker completion AND legacy failure/lease-expiry projection.
      job_execution_token: `cancelled:${jobId}`, files_generating: false, files_regenerating: false,
      files_stale: true, job_error: "", processing_completed_at: new Date() },
    $unset: { report_job_outbox: 1 } }, { new: true }).lean();
  if (!updated) {
    const current = await ownedSalvageReport(report._id, report.user);
    if (current.job_id === jobId && current.job_status === "cancelled" && Number(current.revision || 0) === baseRevision) {
      await cancelQueue(); return current;
    }
    throw new SalvageWorkflowError(409, "The report changed before it could be stopped. Reload its current state.", "SALVAGE_GENERATION_CONFLICT");
  }
  // An ambiguous queue write does not undo the report fence. The same request
  // can be retried; workers also check the parent before further side effects.
  await cancelQueue();
  return updated;
}

/** An explicit paid action, separate from text saves and artifact generation. */
export async function requestSalvageResearch(report: any, baseRevision: unknown, clientRequestId: unknown): Promise<any> {
  if (typeof clientRequestId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/.test(clientRequestId)) {
    throw new SalvageWorkflowError(400, "A stable client_request_id is required for research.");
  }
  const existing = (report.research_requests || []).find((entry: any) => entry.clientRequestId === clientRequestId);
  if (existing) {
    if (existing.baseRevision !== baseRevision) throw new SalvageWorkflowError(409, "This research request ID was already used for another revision.", "SALVAGE_RESEARCH_REQUEST_CONFLICT");
    await dispatchSalvage(String(report._id));
    return report;
  }
  requireRevision(report, baseRevision);
  if (salvageBusy(report)) throw new SalvageWorkflowError(409, "Wait for the current processing to finish before starting another research run.");
  if (!report.preview_data) throw new SalvageWorkflowError(409, "Retry initial analysis before requesting new research.");
  const jobId = `salvage-${report._id}-${randomUUID()}`;
  const requestEntry = { clientRequestId, baseRevision: Number(baseRevision), jobId, requestedAt: new Date() };
  const updated = await SalvageReport.findOneAndUpdate({ _id: report._id, user: report.user, ...revisionFilter(report), job_id: report.job_id,
    job_status: { $nin: ["queued", "processing"] }, files_generating: { $ne: true }, "research_requests.clientRequestId": { $ne: clientRequestId } },
  { $set: { workflow_version: 1, status: "processing", generation_kind: "preview", generation_revision: Number(baseRevision),
      preview_data: salvageSnapshot(report), job_id: jobId, job_status: "queued", job_error: "", generation_attempt: 0,
      files_generating: false, files_stale: true, queued_at: new Date(), generation_progress: { percent: 0, message: "Queued a new Canadian salvage research run." },
      report_job_outbox: outbox(String(report._id), jobId, "preview", Number(baseRevision)) },
    $unset: { job_execution_token: 1, research_checkpoint: 1 }, $push: { research_requests: requestEntry } }, { new: true }).select("+research_requests").lean();
  if (!updated) {
    // A concurrent replay may have accepted this exact paid run while the caller
    // awaited Mongo. Resolve the persisted identity rather than queueing again.
    const winner: any = await SalvageReport.findOne({ _id: report._id, user: report.user } as any).select("+research_requests").lean();
    if ((winner?.research_requests || []).some((entry: any) => entry.clientRequestId === clientRequestId && entry.baseRevision === baseRevision)) {
      await dispatchSalvage(String(report._id));
      return winner;
    }
    throw new SalvageWorkflowError(409, "This report changed. Reload before researching again.", "SALVAGE_REVISION_CONFLICT");
  }
  await dispatchSalvage(String(report._id), jobId);
  return updated;
}
