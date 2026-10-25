import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import archiver from "archiver";
import SalvageReport from "../models/salvage.model.js";
import PdfReport from "../models/pdfReport.model.js";
import { runEnterpriseSalvageAssessment, type SalvageResearchCheckpoint } from "../service/salvageResearchPipeline.js";
import { generateSalvagePdfFromReport } from "../service/salvagePdfService.js";
import { generateSalvageDocx } from "../service/docx/salvageDocxBuilder.js";
import { generateSalvageXlsx } from "../service/xlsx/salvageXlsxService.js";
import { normalizeSalvageReportData } from "../service/salvageReportData.js";
import { isSalvageAssessmentV2, projectSalvageAssessmentLegacyFields } from "../service/salvageAssessment.js";
import { editableSalvageData, salvageSnapshot } from "../service/salvageWorkflowService.js";
import { advanceSalvageProgress } from "../service/salvageProgress.js";
import { assignReportApprover, sendAssignedApprovalEmail } from "../service/approvalAssignmentService.js";
import { deserializeMulterFiles } from "../utils/multerFileSerialization.js";
import { cleanupReportJobSourceFiles, readMulterFileBuffer } from "../utils/reportTempFiles.js";
import { getCurrentR2StorageTarget, uploadBufferToR2, uploadFilePathToR2, resolveR2ObjectLocationFromUrl, readR2ObjectBuffer } from "../utils/r2Storage/r2Upload.js";
import { ReportJobOwnershipLostError, type ReportJobHandler, type ReportJobExecutionContext } from "../utils/reportJobMongoQueue.js";

/** All report writes are fenced by logical generation AND the leased worker attempt. */
async function execution(job: any, context: ReportJobExecutionContext) {
  await context.assertOwned();
  const logical = { _id: job.reportId, job_id: job.payload.generationToken };
  let report: any = await SalvageReport.findOne(logical).select("+source_files +job_execution_token +research_checkpoint +assessment_edit_history").lean();
  if (!report) throw new ReportJobOwnershipLostError("Salvage generation was superseded.");
  if (report.job_status === "done") return { report, done: true, filter: logical };
  const attempt = Number(job.attempts || 1);
  await context.assertOwned();
  report = await SalvageReport.findOneAndUpdate({ ...logical, job_status: { $in: ["queued", "processing"] },
    $or: [{ generation_attempt: { $exists: false } }, { generation_attempt: { $lte: attempt } }],
    job_execution_token: report.job_execution_token }, { $set: { generation_attempt: attempt, job_execution_token: context.executionToken, job_status: "processing" } }, { new: true }).select("+source_files +research_checkpoint +assessment_edit_history").lean();
  if (!report) throw new ReportJobOwnershipLostError("Salvage worker attempt was superseded.");
  const filter = { ...logical, job_execution_token: context.executionToken };
  return { report, done: false, filter };
}
async function guardedUpdate(filter: any, context: ReportJobExecutionContext, update: any) {
  await context.assertOwned();
  const result = await SalvageReport.updateOne(filter, update);
  if (!result.matchedCount) throw new ReportJobOwnershipLostError("Salvage generation no longer owns the report.");
}
async function progress(filter: any, context: ReportJobExecutionContext, percent: number, label: string) {
  await context.assertOwned();
  const current = await SalvageReport.findOne(filter).select("generation_progress").lean();
  if (!current) throw new ReportJobOwnershipLostError("Salvage generation was stopped or superseded.");
  await guardedUpdate(filter, context, { $set: { generation_progress: advanceSalvageProgress(current.generation_progress, percent, label) } });
}

function fencedContext(filter: any, context: ReportJobExecutionContext): ReportJobExecutionContext {
  return { ...context, assertOwned: async () => {
    await context.assertOwned();
    if (!await SalvageReport.exists({ ...filter, job_status: "processing" })) {
      throw new ReportJobOwnershipLostError("Salvage generation was stopped or superseded.");
    }
  } };
}

export const runSalvagePreviewJob: ReportJobHandler = async (job, context) => {
  const { report, done, filter } = await execution(job, context);
  if (done) return;
  context = fencedContext(filter, context);
  const startingRevision = Number(report.revision || 0);
  if (startingRevision !== Number(job.payload.revision || 0)) throw new ReportJobOwnershipLostError("The saved preview revision changed.");
  const researchFilter = { ...filter, revision: startingRevision };
  const originals = deserializeMulterFiles(report.source_files || []);
  const imageUrls: string[] = [...(report.imageUrls || [])];
  const target = getCurrentR2StorageTarget();
  for (let index = imageUrls.length; index < originals.length; index++) {
    await context.assertOwned();
    const file = originals[index];
    const buffer = await readMulterFileBuffer(file);
    if (!buffer.length) throw new Error("An original photo is missing. Retry or contact support before submitting.");
    const hash = createHash("sha256").update(buffer).digest("hex");
    const extension = path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, "").slice(0, 10) || ".jpg";
    // Content-addressed per-position keys make upload retries safe and preserve duplicate filenames/order.
    const url = await uploadBufferToR2(buffer, file.mimetype, target.bucketName, `salvage/${report._id}/originals/${String(index + 1).padStart(3, "0")}-${hash}${extension}`);
    imageUrls.push(url);
    await guardedUpdate(filter, context, { $set: { imageUrls } });
    await progress(filter, context, Math.round((index + 1) / originals.length * 25), "Saving original photos");
  }
  // Only release local originals after every remote URL has been durably checkpointed.
  await guardedUpdate(filter, context, { $set: { imageUrls }, $unset: { source_files: 1 } });
  await cleanupReportJobSourceFiles(originals);
  const facts = editableSalvageData(report.preview_data || report);
  const result = await runEnterpriseSalvageAssessment({
    snapshot: { ...facts, assessment: report.preview_data?.assessment || report.assessment, imageUrls }, imageUrls,
    checkpoint: report.research_checkpoint as SalvageResearchCheckpoint | undefined,
    onCheckpoint: async checkpoint => {
      // A reservation is persisted before a paid call. Retried jobs inherit it,
      // including ambiguous charges, rather than receiving a fresh allowance.
      await guardedUpdate(researchFilter, context, { $set: { research_checkpoint: checkpoint } });
    },
    onProgress: async (stage, percent) => { await progress(researchFilter, context, Math.max(25, Math.min(99, percent)), stage); },
  });
  // Non-empty user observations always override machine-extracted identity and condition.
  const supplied = Object.fromEntries(Object.entries(facts).filter(([, value]) => value !== "" && value != null && (!Array.isArray(value) || value.length)));
  // Research-owned calculations and provenance cannot be replaced by legacy
  // snapshot fields; only appraiser facts survive as authoritative overrides.
  const { assessment_inputs: _inputs, valuation: _valuation, ...suppliedFacts } = supplied;
  const snapshot = normalizeSalvageReportData({ ...result, ...suppliedFacts,
    assessment_inputs: result.assessment_inputs || facts.assessment_inputs,
    currency: result.assessment ? "CAD" : result.currency || facts.currency || "CAD", imageUrls });
  if (isSalvageAssessmentV2(snapshot.assessment)) Object.assign(snapshot, projectSalvageAssessmentLegacyFields(snapshot.assessment));
  await guardedUpdate({ ...filter, revision: startingRevision }, context, { $set: { ...editableSalvageData(snapshot), imageUrls,
    assessment: snapshot.assessment, aiExtractedDetails: snapshot.aiExtractedDetails, comparableItems: snapshot.comparableItems || [],
    preview_data: snapshot, status: "preview", revision: startingRevision + 1, job_status: "done", job_error: "", files_stale: true, files_generating: false, files_regenerating: false,
    analysis_warning: snapshot.analysis_warning || "", analysis_model: snapshot.analysis_model, "generation_progress.percent": 100, processing_completed_at: new Date() } });
};

async function originalPhotoZip(urls: string[], filePath: string, context: ReportJobExecutionContext): Promise<void> {
  const output = createWriteStream(filePath);
  const archive = archiver("zip", { zlib: { level: 3 } });
  const finished = new Promise<void>((resolve, reject) => { output.on("close", resolve); output.on("error", reject); archive.on("error", reject); });
  // Attach a rejection observer immediately while original-photo reads are in progress.
  void finished.catch(() => undefined);
  archive.pipe(output);
  try {
    for (let index = 0; index < urls.length; index++) {
      await context.assertOwned();
      const location = resolveR2ObjectLocationFromUrl(urls[index]);
      if (!location) throw new Error("An original photo is outside configured storage. Contact support to recover it.");
      const bytes = await readR2ObjectBuffer(location.bucketName, location.key, 25 * 1024 * 1024);
      const extension = path.extname(location.key).replace(/[^.a-zA-Z0-9]/g, "").slice(0, 10) || ".jpg";
      const appended = new Promise<void>((resolve, reject) => { archive.once("entry", () => { archive.off("error", reject); resolve(); }); archive.once("error", reject); });
      archive.append(bytes, { name: `photo-${String(index + 1).padStart(3, "0")}${extension}` });
      await appended;
    }
    await archive.finalize();
    await finished;
  } catch (error) { archive.abort(); output.destroy(); throw error; }
}

export const runSalvageFilesJob: ReportJobHandler = async (job, context) => {
  const { report, done, filter } = await execution(job, context);
  if (done) return;
  context = fencedContext(filter, context);
  if (Number(report.revision || 0) !== Number(job.payload.revision)) throw new ReportJobOwnershipLostError("The saved preview revision changed.");
  const snapshot = salvageSnapshot(report);
  const generation = String(job.payload.generationToken);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "assetinsight-salvage-"));
  try {
    await progress(filter, context, 10, "Creating PDF from saved preview");
    const pdf = await generateSalvagePdfFromReport(snapshot);
    await progress(filter, context, 35, "Creating Word report");
    const docx = await generateSalvageDocx(snapshot);
    await progress(filter, context, 55, "Creating Excel workbook");
    const xlsx = await generateSalvageXlsx(snapshot);
    await progress(filter, context, 65, "Packing original photos");
    const zipPath = path.join(dir, "photos.zip");
    await originalPhotoZip(snapshot.imageUrls || [], zipPath, context);
    const target = getCurrentR2StorageTarget();
    // Each worker attempt writes its own immutable artifact set; stale attempts cannot overwrite a winner.
    const prefix = `salvage/${report._id}/files/${generation}/${context.executionToken}`;
    const files: Record<string, string> = {};
    const types = { pdf: "application/pdf", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" };
    for (const [key, buffer] of Object.entries({ pdf, docx, xlsx })) {
      await context.assertOwned();
      if (!buffer.length) throw new Error(`The ${key} generator returned an empty file.`);
      files[key] = await uploadBufferToR2(buffer, types[key as keyof typeof types], target.bucketName, `${prefix}/report.${key}`);
    }
    await context.assertOwned();
    files.images = await uploadFilePathToR2(zipPath, "application/zip", target.bucketName, `${prefix}/photos.zip`);
    await progress(filter, context, 90, "Publishing complete file set");
    const assignment: any = { user: report.user };
    await assignReportApprover(assignment, { userId: report.user });
    const ids: Record<string, string> = {};
    for (const key of ["pdf", "docx", "xlsx", "images"] as const) {
      await context.assertOwned();
      // Generation-specific IDs fence stale workers at the artifact layer as well as the parent.
      const id = createHash("sha256").update(`salvage:${report._id}:${generation}:${context.executionToken}:${key}`).digest("hex").slice(0, 24);
      ids[key] = id;
      await PdfReport.updateOne({ _id: id }, { $setOnInsert: { ...assignment, _id: id, report: report._id, reportType: "Salvage", reportModel: "SalvageReport",
        filename: `salvage-${String(snapshot.file_number || report._id).replace(/[^a-zA-Z0-9_-]/g, "-")}.${key === "images" ? "zip" : key}`,
        address: snapshot.company_address || "Not provided", fairMarketValue: String(snapshot.valuation?.fairMarketValue || "Unavailable"), fileType: key,
        filePath: files[key], artifact_generation: `${generation}:${context.executionToken}`, approvalStatus: "pending", release_status: "pending_release" } }, { upsert: true, runValidators: true });
    }
    await guardedUpdate({ ...filter, revision: Number(job.payload.revision) }, context, { $set: { files, artifact_ids: ids,
      artifact_generation: `${generation}:${context.executionToken}`, files_stale: false, files_generating: false, files_regenerating: false,
      status: "pending_approval", job_status: "done", job_error: "", "generation_progress.percent": 100, processing_completed_at: new Date() } });
    // Notifications only follow successful publication and never decide job success.
    const anchor = await PdfReport.findById(ids.pdf);
    if (anchor) await sendAssignedApprovalEmail(anchor).catch(() => undefined);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
};
