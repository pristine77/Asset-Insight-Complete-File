import AssetReport from "../models/asset.model.js";
import LotListing from "../models/lotListing.model.js";
import ReportJob from "../models/reportJob.model.js";
import { buildSpecReportData } from "../service/auctioneerSpecPdfRefreshService.js";
import { generateAuctioneerSpecSheetPdfFromReport } from "../service/auctioneerSpecSheetPdfService.js";
import { generateAuctioneerSpecSheetDocxFromReport } from "../service/auctioneerSpecSheetDocxService.js";
import { generateAssetXlsxFromReport } from "../service/xlsx/assetXlsxService.js";
import { prepareReportYoutubeVideos } from "../service/youtubeVideoService.js";
import {
  generateAndUploadScheduleAPdf,
  generateScheduleAPdfFromReport,
} from "../service/scheduleAReportPdfService.js";
import { setReportGenerationProgress } from "../service/reportGenerationProgressService.js";
import {
  buildReportArtifactFilenames,
  getReportContractNumber,
} from "../utils/reportArtifactNames.js";
import { uploadBufferToR2 } from "../utils/r2Storage/r2Upload.js";
import { randomUUID } from "crypto";
import { sha256Buffer } from "../utils/sha256Buffer.js";
import { enqueueReportJob } from "../utils/reportJobQueue.js";
import {
  buildReportJobOutbox,
  ensureReportJobOutbox,
  type ReportJobOutbox,
  type ReportJobExecutionContext,
  shouldUseMongoReportQueue,
} from "../utils/reportJobMongoQueue.js";
import { queueAssetScheduleSheetRegeneration } from "../service/assetScheduleSheetRegenerationService.js";

const EXCEL_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const CR_DOCX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

type ExcelCrJobInput = {
  kind: "asset" | "lotListing";
  reportId: string;
  generationToken: string;
  /** Present only for one claimed durable-queue execution attempt. */
  executionContext?: ReportJobExecutionContext;
};

class ExcelCrExecutionOwnershipLostError extends Error {
  readonly code = "EXCEL_CR_EXECUTION_OWNERSHIP_LOST";

  constructor(reportId: string) {
    super(`Excel/CR regeneration no longer owns report ${reportId}`);
    this.name = "ExcelCrExecutionOwnershipLostError";
  }
}

export class ExcelCrRegenerationQueueError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string
  ) {
    super(message);
    this.name = "ExcelCrRegenerationQueueError";
  }
}

function modelFor(kind: ExcelCrJobInput["kind"]): any {
  return kind === "asset" ? AssetReport : LotListing;
}

function excelCrJobType(kind: ExcelCrJobInput["kind"]) {
  return kind === "asset"
    ? ("asset-excel-cr-files" as const)
    : ("lot-listing-excel-cr-files" as const);
}

async function activeExcelCrJob(input: {
  kind: ExcelCrJobInput["kind"];
  reportId: string;
  generationToken?: string;
}) {
  if (!shouldUseMongoReportQueue()) return null;
  return ReportJob.findOne({
    reportId: input.reportId,
    type: excelCrJobType(input.kind),
    ...(input.generationToken
      ? { progressId: input.generationToken }
      : {}),
    status: { $in: ["queued", "processing", "completed"] },
  })
    .select("_id type progressId payload status idempotencyKey")
    .lean();
}

function excelCrQueueInput(input: ExcelCrJobInput) {
  return {
    type: excelCrJobType(input.kind),
    reportId: input.reportId,
    progressId: input.generationToken,
    idempotencyKey: `${excelCrJobType(input.kind)}:${input.reportId}:${input.generationToken}`,
    payload: {
      reportId: input.reportId,
      generationToken: input.generationToken,
      notifyOwnerOnFailure: false,
    },
    priority: 2,
    maxAttempts: 3,
    targetStatus: "approved" as const,
  };
}

export function buildExcelCrRegenerationJobOutbox(
  input: ExcelCrJobInput
): ReportJobOutbox {
  return buildReportJobOutbox(excelCrQueueInput(input));
}

function excelCrOutboxMatches(
  outbox: ReportJobOutbox | undefined,
  input: ExcelCrJobInput
): boolean {
  const queueInput = excelCrQueueInput(input);
  return Boolean(
    outbox?.token &&
      outbox.type === queueInput.type &&
      String(outbox.reportId || "") === input.reportId &&
      String(outbox.progressId || "") === input.generationToken &&
      String(outbox.idempotencyKey || "") === queueInput.idempotencyKey &&
      String(outbox.payload?.generationToken || "") === input.generationToken
  );
}

async function clearExcelCrQueueClaim(input: {
  kind: ExcelCrJobInput["kind"];
  reportId: string;
  generationToken: string;
}) {
  const Model = modelFor(input.kind);
  await Model.updateOne(
    {
      _id: input.reportId,
      excel_cr_regeneration_claim_token: input.generationToken,
    },
    {
      $unset: {
        excel_cr_regeneration_claim_token: 1,
        excel_cr_regeneration_claimed_at: 1,
      },
    }
  );
}

async function ensureExcelCrQueueClaim(
  input: ExcelCrJobInput,
  persistedOutbox?: ReportJobOutbox
) {
  const Model = modelFor(input.kind);
  let report: any = await Model.findOne(
    {
      _id: input.reportId,
      job_id: input.generationToken,
      excel_cr_regeneration_claim_token: input.generationToken,
    }
  )
    .select("+report_job_outbox job_id job_status job_execution_token")
    .lean();

  if (!report) {
    const [current, exactJob] = await Promise.all([
      Model.findById(input.reportId).select("job_id job_status").lean(),
      activeExcelCrJob({ ...input, generationToken: input.generationToken }),
    ]);
    if (
      exactJob &&
      String((current as any)?.job_id || "") === input.generationToken
    ) {
      await clearExcelCrQueueClaim(input);
      return {
        jobId: String((exactJob as any)._id || input.generationToken),
        progressId: input.generationToken,
      };
    }
    // A later report operation may already own the shared file-generation
    // fields. Retire only this stale typed claim and never recreate its job.
    await clearExcelCrQueueClaim(input);
    throw new ExcelCrRegenerationQueueError(
      409,
      "EXCEL_CR_REGENERATION_IN_PROGRESS",
      "This report is already generating files."
    );
  }

  let outbox =
    (report.report_job_outbox as ReportJobOutbox | undefined) ||
    persistedOutbox;
  if (outbox && !excelCrOutboxMatches(outbox, input)) {
    throw Object.assign(
      new Error("A different durable report operation already owns this report."),
      { code: "EXCEL_CR_OUTBOX_CONFLICT", statusCode: 409 }
    );
  }

  if (!outbox) {
    const exactJob = await activeExcelCrJob({
      ...input,
      generationToken: input.generationToken,
    });
    if (exactJob) {
      await clearExcelCrQueueClaim(input);
      return {
        jobId: String((exactJob as any)._id || input.generationToken),
        progressId: input.generationToken,
      };
    }

    // Upgrade a claim left by an older release into the generic restart-scanned
    // outbox without reopening the shared generation flags.
    const candidate = buildExcelCrRegenerationJobOutbox(input);
    report = await Model.findOneAndUpdate(
      {
        _id: input.reportId,
        job_id: input.generationToken,
        job_status: "queued",
        excel_cr_regeneration_claim_token: input.generationToken,
        "report_job_outbox.token": { $exists: false },
        $or: [
          { job_execution_token: { $exists: false } },
          { job_execution_token: null },
        ],
      },
      { $set: { report_job_outbox: candidate } },
      { returnDocument: "after" }
    )
      .select("+report_job_outbox")
      .lean();
    if (!report) {
      report = await Model.findOne({
        _id: input.reportId,
        job_id: input.generationToken,
        excel_cr_regeneration_claim_token: input.generationToken,
      })
        .select("+report_job_outbox")
        .lean();
    }
    outbox = report?.report_job_outbox as ReportJobOutbox | undefined;
    if (!excelCrOutboxMatches(outbox, input)) {
      throw Object.assign(
        new Error("The Excel/CR worker handoff changed while it was being recovered."),
        { code: "EXCEL_CR_OUTBOX_CONFLICT", statusCode: 409 }
      );
    }
  }

  try {
    const job = await ensureReportJobOutbox(
      input.kind,
      input.reportId,
      outbox!.token
    );
    if (
      !job ||
      job.type !== excelCrJobType(input.kind) ||
      String(job.progressId || "") !== input.generationToken ||
      String(job.payload?.generationToken || "") !== input.generationToken
    ) {
      throw new Error("A conflicting Excel/CR regeneration job already exists");
    }
    await clearExcelCrQueueClaim(input);
    return {
      jobId: String(job._id || input.generationToken),
      progressId: input.generationToken,
    };
  } catch (error) {
    const active = await activeExcelCrJob({
      ...input,
      generationToken: input.generationToken,
    });
    if (
      active &&
      String((active as any).progressId || "") === input.generationToken
    ) {
      await clearExcelCrQueueClaim(input);
      return {
        jobId: String((active as any)._id || input.generationToken),
        progressId: input.generationToken,
      };
    }
    // Keep the typed claim and shared file flags as a durable outbox. A retry
    // can safely ensure the same-type deduplicated job without reopening a
    // window for PV or generic preview writers.
    throw error;
  }
}

function proposalValuationRevisionCondition(revision: number) {
  return revision === 0
    ? {
        $or: [
          { proposal_valuation_revision: 0 },
          { proposal_valuation_revision: { $exists: false } },
          { proposal_valuation_revision: null },
        ],
      }
    : { proposal_valuation_revision: revision };
}

function versionedArtifactName(filename: string, generationToken: string): string {
  const suffix = generationToken.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12);
  const extensionIndex = filename.lastIndexOf(".");
  if (extensionIndex <= 0) return `${filename}-${suffix}`;
  return `${filename.slice(0, extensionIndex)}-${suffix}${filename.slice(extensionIndex)}`;
}

async function contentAddressedArtifactName(
  filename: string,
  generationToken: string,
  buffer: Buffer
): Promise<string> {
  const digest = await sha256Buffer(buffer);
  const versioned = versionedArtifactName(filename, generationToken);
  const extensionIndex = versioned.lastIndexOf(".");
  if (extensionIndex <= 0) return `${versioned}-${digest}`;
  return `${versioned.slice(0, extensionIndex)}-${digest}${versioned.slice(
    extensionIndex
  )}`;
}

async function markMemoryQueueFailure(input: ExcelCrJobInput, error: unknown) {
  const Model = modelFor(input.kind);
  const message = error instanceof Error ? error.message : String(error);
  await Model.findOneAndUpdate(
    { _id: input.reportId, job_id: input.generationToken },
    {
      $set: {
        files_generating: false,
        files_regenerating: false,
        job_status: "error",
        job_error: message,
        processing_completed_at: new Date(),
        generation_progress: {
          stage: "error",
          progressPercent: 100,
          message,
          updatedAt: new Date(),
        },
      },
      $unset: { job_execution_token: 1 },
    }
  );
}

/** Atomically reserve one report and enqueue its editor-driven regeneration. */
export async function queueExcelCrRegenerationJob(input: {
  kind: ExcelCrJobInput["kind"];
  reportId: string;
}) {
  const Model = modelFor(input.kind);
  if (shouldUseMongoReportQueue()) {
    const existingClaim = await Model.findById(input.reportId)
      .select("+report_job_outbox excel_cr_regeneration_claim_token")
      .lean();
    const existingToken = String(
      (existingClaim as any)?.excel_cr_regeneration_claim_token || ""
    );
    if (existingToken) {
      return ensureExcelCrQueueClaim({
        ...input,
        generationToken: existingToken,
      }, (existingClaim as any)?.report_job_outbox);
    }
  }
  const generationToken = randomUUID();
  const queuedAt = new Date();
  const jobInput: ExcelCrJobInput = {
    ...input,
    generationToken,
  };
  const outbox = shouldUseMongoReportQueue()
    ? buildExcelCrRegenerationJobOutbox(jobInput)
    : undefined;
  const locked = await Model.findOneAndUpdate(
    {
      _id: input.reportId,
      status: "approved",
      files_generating: { $ne: true },
      files_regenerating: { $ne: true },
      excel_regenerating: { $ne: true },
      job_status: { $nin: ["queued", "processing"] },
      excel_cr_regeneration_claim_token: { $in: [null, ""] },
      "report_job_outbox.token": { $exists: false },
      ...(input.kind === "asset"
        ? {
            proposal_valuation_regeneration_claim_token: {
              $in: [null, ""],
            },
          }
        : {}),
    },
    {
      $set: {
        files_generating: true,
        files_regenerating: true,
        job_id: generationToken,
        job_status: "queued",
        queued_at: queuedAt,
        excel_cr_regeneration_claim_token: generationToken,
        excel_cr_regeneration_claimed_at: queuedAt,
        ...(outbox ? { report_job_outbox: outbox } : {}),
        generation_progress: {
          stage: "queued",
          progressPercent: 0,
          message: "Excel and CR regeneration queued",
          updatedAt: queuedAt,
        },
      },
      $unset: {
        job_error: 1,
        job_execution_token: 1,
        processing_started_at: 1,
        processing_completed_at: 1,
      },
    },
    { new: true }
  );
  if (!locked) {
    throw new ExcelCrRegenerationQueueError(
      409,
      "EXCEL_CR_REGENERATION_IN_PROGRESS",
      "This report is already generating files."
    );
  }

  if (shouldUseMongoReportQueue()) {
    return ensureExcelCrQueueClaim(jobInput, outbox);
  }

  try {
    enqueueReportJob(`excel-cr-files:${input.reportId}`, () =>
      runExcelCrRegenerationJob(jobInput).catch(async (error) => {
        await markMemoryQueueFailure(jobInput, error).catch(() => undefined);
        console.error("[ExcelCrRegenerationJob] Failed:", error);
      })
    );
    await clearExcelCrQueueClaim(jobInput);
    return { jobId: generationToken, progressId: generationToken };
  } catch (error) {
    await Model.findOneAndUpdate(
      {
        _id: input.reportId,
        job_id: generationToken,
        excel_cr_regeneration_claim_token: generationToken,
        job_status: "queued",
      },
      {
        $set: {
          files_generating: false,
          files_regenerating: false,
          job_status: "error",
          job_error: "Failed to queue Excel and CR regeneration.",
          processing_completed_at: new Date(),
          generation_progress: {
            stage: "error",
            progressPercent: 100,
            message: "Failed to queue Excel and CR regeneration.",
            updatedAt: new Date(),
          },
        },
        $unset: {
          excel_cr_regeneration_claim_token: 1,
          excel_cr_regeneration_claimed_at: 1,
          job_execution_token: 1,
        },
      }
    ).catch(() => undefined);
    throw error;
  }
}

async function runArtifactStep<T>(
  artifact: "Excel" | "CR PDF" | "CR DOCX" | "Schedule A PDF",
  step: "generation" | "upload",
  operation: () => Promise<T>
): Promise<T> {
  try {
    return await operation();
  } catch (error: any) {
    throw new Error(`${artifact} ${step} failed: ${error?.message || String(error)}`);
  }
}

/**
 * Regenerate only the three files affected by the Excel/CR editor.
 *
 * Each complete artifact is uploaded before the next one is generated. Keeping
 * Chromium's PDF image work separate from the DOCX image cache avoids the large
 * multiplicative memory peak that the former API-request Promise.all created.
 */
export async function runExcelCrRegenerationJob(input: ExcelCrJobInput) {
  if (!input.generationToken) {
    throw new Error("Excel/CR regeneration job is missing its generation token");
  }
  const Model = modelFor(input.kind);
  const executionContext = input.executionContext;
  const executionToken = String(executionContext?.executionToken || "").trim();
  if (executionContext && !executionToken) {
    throw new ExcelCrExecutionOwnershipLostError(input.reportId);
  }
  const reportClaim = (
    jobStatus: "processing" | "done" | { $in: string[] } = "processing"
  ) => ({
    job_id: input.generationToken,
    ...(executionToken ? { job_execution_token: executionToken } : {}),
    job_status: jobStatus,
  });
  const assertAttemptOwned = async (allowCompletedReport = false) => {
    if (!executionContext) return;
    await executionContext.assertOwned();
    const owned = await Model.exists({
      _id: input.reportId,
      ...reportClaim(
        allowCompletedReport
          ? { $in: ["processing", "done"] }
          : "processing"
      ),
    });
    if (!owned) throw new ExcelCrExecutionOwnershipLostError(input.reportId);
  };
  const startedAt = new Date();
  await executionContext?.assertOwned();
  const report = await Model.findOneAndUpdate(
    {
      _id: input.reportId,
      status: "approved",
      job_id: input.generationToken,
      files_regenerating: true,
      job_status: { $in: ["queued", "processing"] },
    },
    {
      $set: {
        files_generating: true,
        files_regenerating: true,
        job_status: "processing",
        ...(executionToken ? { job_execution_token: executionToken } : {}),
        processing_started_at: startedAt,
      },
      $unset: {
        job_error: 1,
        excel_cr_regeneration_claim_token: 1,
        excel_cr_regeneration_claimed_at: 1,
      },
    },
    { new: true }
  ).populate("user", "email username name companyName");
  if (!report) {
    const alreadyCompleted: any = await Model.findOne({
      _id: input.reportId,
      job_id: input.generationToken,
      job_status: "done",
      files_generating: { $ne: true },
      files_regenerating: { $ne: true },
    }).lean();
    if (alreadyCompleted) {
      await executionContext?.assertOwned();
      if (
        input.kind === "asset" &&
        Boolean(alreadyCompleted.files_regeneration_pending)
      ) {
        await queueAssetScheduleSheetRegeneration(
          input.reportId,
          Number(alreadyCompleted.proposal_valuation_revision || 0)
        );
      }
      if (executionContext) {
        await Model.updateOne(
          {
            _id: input.reportId,
            job_id: input.generationToken,
            job_status: "done",
          },
          { $unset: { job_execution_token: 1 } }
        );
      }
      return;
    }
    throw new ExcelCrExecutionOwnershipLostError(input.reportId);
  }
  await assertAttemptOwned();
  const proposalValuationGenerationRevision = Number(
    (report as any)?.proposal_valuation_revision || 0
  );

  const bucket = process.env.R2_BUCKET_NAME;
  if (!bucket) throw new Error("R2_BUCKET_NAME is required to regenerate Excel/CR");

  const progress = async (
    progressPercent: number,
    message: string,
    stage: "generating_files" | "ready" = "generating_files"
  ) =>
    setReportGenerationProgress({
      kind: input.kind,
      reportId: input.reportId,
      progressId: input.generationToken,
      generationToken: input.generationToken,
      executionToken: executionToken || undefined,
      stage,
      progressPercent,
      message,
    });

  let reportData = buildSpecReportData(report);
  const folder = input.kind === "lotListing" ? "lot-listings" : "previews";
  const names = buildReportArtifactFilenames({
    kind: input.kind,
    contractNo: getReportContractNumber(reportData, input.reportId),
    reportId: input.reportId,
    fallback: input.reportId,
    lots: reportData.lots,
  });
  const objectNames = {
    excel: versionedArtifactName(names.excel, input.generationToken),
    crPdf: versionedArtifactName(names.crPdf, input.generationToken),
    crDocx: versionedArtifactName(names.crDocx, input.generationToken),
    scheduleAPdf: versionedArtifactName(names.scheduleAPdf, input.generationToken),
  };
  const timestamp = Date.now();
  let excelUrl = "";
  let crPdfUrl = "";
  let crDocxUrl = "";
  let scheduleAPdfUrl = "";

  const generateOwned = async <T>(
    artifact: "Excel" | "CR PDF" | "CR DOCX" | "Schedule A PDF",
    operation: () => Promise<T>
  ): Promise<T> => {
    await assertAttemptOwned();
    const value = await runArtifactStep(artifact, "generation", operation);
    await assertAttemptOwned();
    return value;
  };
  const uploadOwned = async (
    artifact: "Excel" | "CR PDF" | "CR DOCX" | "Schedule A PDF",
    buffer: Buffer,
    contentType: string,
    baseName: string
  ): Promise<string> => {
    const objectName = executionContext
      ? await contentAddressedArtifactName(baseName, input.generationToken, buffer)
      : baseName;
    await assertAttemptOwned();
    const uploaded = await runArtifactStep(artifact, "upload", () =>
      uploadBufferToR2(buffer, contentType, bucket, `${folder}/${objectName}`)
    );
    await assertAttemptOwned();
    return `${uploaded}?v=${timestamp}`;
  };

  await progress(5, "Generating Schedule A PDF");
  {
    if (executionContext) {
      const buffer = await generateOwned("Schedule A PDF", () =>
        generateScheduleAPdfFromReport(reportData)
      );
      scheduleAPdfUrl = await uploadOwned(
        "Schedule A PDF",
        buffer,
        "application/pdf",
        objectNames.scheduleAPdf
      );
    } else {
      const scheduleA = await runArtifactStep(
        "Schedule A PDF",
        "generation",
        () =>
          generateAndUploadScheduleAPdf({
            reportData,
            kind: input.kind,
            reportId: input.reportId,
            folder,
            objectName: objectNames.scheduleAPdf,
          })
      );
      scheduleAPdfUrl = scheduleA.url;
    }
    reportData = {
      ...reportData,
      schedule_a_pdf_url: scheduleAPdfUrl,
    };
  }

  await progress(25, "Generating Excel");
  {
    await prepareReportYoutubeVideos({
      reportType: input.kind, reportId: input.reportId, enabled: report.youtube_videos_enabled,
      generationToken: input.generationToken, lots: reportData.lots || [],
      assertOwned: assertAttemptOwned, existingUploadsOnly: true,
    });
    const buffer = await generateOwned("Excel", () =>
      generateAssetXlsxFromReport(reportData, {
        includeScheduleAColumn: input.kind === "asset",
      })
    );
    excelUrl = await uploadOwned(
      "Excel",
      buffer,
      EXCEL_CONTENT_TYPE,
      objectNames.excel
    );
  }

  await progress(45, "Generating CR PDF");
  {
    const buffer = await generateOwned("CR PDF", () =>
      generateAuctioneerSpecSheetPdfFromReport(reportData)
    );
    crPdfUrl = await uploadOwned(
      "CR PDF",
      buffer,
      "application/pdf",
      objectNames.crPdf
    );
  }

  await progress(75, "Generating CR DOCX");
  {
    const buffer = await generateOwned("CR DOCX", () =>
      generateAuctioneerSpecSheetDocxFromReport(reportData)
    );
    crDocxUrl = await uploadOwned(
      "CR DOCX",
      buffer,
      CR_DOCX_CONTENT_TYPE,
      objectNames.crDocx
    );
  }

  const completedAt = new Date();
  const set: Record<string, unknown> = {
    "preview_files.excel": excelUrl,
    "preview_files.spec_pdf": crPdfUrl,
    "preview_files.cr_docx": crDocxUrl,
    "preview_files.schedule_a_pdf": scheduleAPdfUrl,
    files_regenerating: false,
    files_generating: false,
    job_status: "done",
    processing_completed_at: completedAt,
    generation_progress: {
      stage: "ready",
      progressPercent: 100,
      message: "Excel, CR, and Schedule A files are ready",
      updatedAt: completedAt,
    },
  };
  set["files.excel"] = set["preview_files.excel"];
  set["files.spec_pdf"] = set["preview_files.spec_pdf"];
  set["files.cr_docx"] = set["preview_files.cr_docx"];
  set["files.schedule_a_pdf"] = set["preview_files.schedule_a_pdf"];
  if (input.kind === "asset") set.files_regenerated_at = completedAt;
  await assertAttemptOwned();
  const completed = await Model.findOneAndUpdate(
    {
      _id: input.reportId,
      ...reportClaim(),
      ...(input.kind === "asset"
        ? proposalValuationRevisionCondition(
            proposalValuationGenerationRevision
          )
        : {}),
    },
    {
      $set: set,
      $unset: {
        job_error: 1,
      },
    },
    { new: true }
  );
  if (!completed) {
    if (input.kind === "asset") {
      await executionContext?.assertOwned();
      const latest = await AssetReport.findById(input.reportId)
        .select("proposal_valuation_revision files_regeneration_pending")
        .lean();
      await executionContext?.assertOwned();
      const latestRevision = Number(
        (latest as any)?.proposal_valuation_revision || 0
      );
      if (latestRevision !== proposalValuationGenerationRevision) {
        const superseded = await AssetReport.findOneAndUpdate(
          { _id: input.reportId, ...reportClaim() },
          {
            $set: {
              files_generating: false,
              files_regenerating: false,
              files_regeneration_pending: true,
              job_status: "done",
              processing_completed_at: new Date(),
            },
          }
        );
        if (!superseded) {
          throw new ExcelCrExecutionOwnershipLostError(input.reportId);
        }
        await executionContext?.assertOwned();
        await queueAssetScheduleSheetRegeneration(
          input.reportId,
          latestRevision
        );
        return;
      }
    }
    const alreadyCompleted = await Model.exists({
      _id: input.reportId,
      job_id: input.generationToken,
      job_status: "done",
      files_generating: { $ne: true },
      files_regenerating: { $ne: true },
    });
    if (alreadyCompleted) return;
    throw new Error(`Excel/CR regeneration lost ownership of report ${input.reportId}`);
  }
  if (
    input.kind === "asset" &&
    Boolean((completed as any)?.files_regeneration_pending)
  ) {
    await assertAttemptOwned(true);
    await queueAssetScheduleSheetRegeneration(
      input.reportId,
      Number((completed as any)?.proposal_valuation_revision || 0)
    );
  }
  await progress(100, "Excel and CR files are ready", "ready").catch((error) => {
    console.warn("[ExcelCrRegenerationJob] Final progress update failed:", error);
  });
  if (executionContext) {
    await executionContext.assertOwned();
    const released = await Model.updateOne(
      {
        _id: input.reportId,
        job_id: input.generationToken,
        job_execution_token: executionToken,
        job_status: "done",
      },
      { $unset: { job_execution_token: 1 } }
    );
    if (released.matchedCount !== 1) {
      // A coalesced Asset follow-up can legitimately replace the logical job
      // immediately after this one publishes. In that case this old execution
      // has no remaining report state to mutate and may finish quietly.
      const newerGeneration = await Model.exists({
        _id: input.reportId,
        job_id: { $ne: input.generationToken },
      });
      if (!newerGeneration) {
        throw new ExcelCrExecutionOwnershipLostError(input.reportId);
      }
    }
  }
}
