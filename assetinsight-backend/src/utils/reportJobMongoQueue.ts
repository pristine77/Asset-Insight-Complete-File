import os from "os";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "crypto";
import ReportJob, {
  type IReportJob,
  type ReportJobProgress,
  type ReportJobType,
} from "../models/reportJob.model.js";
import AssetReport from "../models/asset.model.js";
import LotListing from "../models/lotListing.model.js";
import SalvageReport from "../models/salvage.model.js";
import AuctioneerWorkItem from "../models/auctioneerWorkItem.model.js";
import ReportUploadSession from "../models/reportUploadSession.model.js";
import { getPositiveIntEnv } from "./concurrency.js";
import { notifyReportProcessingFailure } from "../service/reportProcessingFailureService.js";
import { deserializeMulterFiles } from "./multerFileSerialization.js";
import { cleanupReportJobSourceFiles } from "./reportTempFiles.js";
import { summarizeError } from "./errorSummary.js";
import { hasRequiredReportFiles } from "./reportFileState.js";
import { reportActivityContext } from "./reportActivityContext.js";

export type CreateReportJobInput = {
  type: ReportJobType;
  reportId?: string;
  progressId?: string;
  payload: Record<string, any>;
  priority?: number;
  maxAttempts?: number;
  idempotencyKey?: string;
  targetStatus?: "preview" | "pending_approval" | "approved";
};

export type ReportJobOutbox = CreateReportJobInput & {
  /** Identifies this exact embedded handoff so a newer transition cannot be cleared. */
  token: string;
  /** Outbox jobs must be idempotent because reconciliation may run repeatedly. */
  idempotencyKey: string;
  createdAt: Date;
};

export type ReportJobOutboxModelKind = "asset" | "lotListing" | "salvage";

export function buildReportJobOutbox(
  input: CreateReportJobInput & { idempotencyKey: string; token?: string }
): ReportJobOutbox {
  const token = String(input.token || randomUUID()).trim();
  const idempotencyKey = String(input.idempotencyKey || "").trim();
  if (!token || !idempotencyKey) {
    throw new Error("Report job outbox requires a token and idempotency key");
  }
  return {
    type: input.type,
    reportId: input.reportId,
    progressId: input.progressId,
    payload: normalizeReportJobPayloadForStorage(input.payload),
    priority: input.priority,
    maxAttempts: input.maxAttempts,
    targetStatus: input.targetStatus,
    idempotencyKey,
    token,
    createdAt: new Date(),
  };
}

function reportModelForOutbox(kind: ReportJobOutboxModelKind): any {
  if (kind === "salvage") return SalvageReport;
  return kind === "lotListing" ? LotListing : AssetReport;
}

function outboxTypeMatchesModel(
  kind: ReportJobOutboxModelKind,
  type: ReportJobType,
): boolean {
  if (kind === "salvage") return type.startsWith("salvage-");
  return kind === "lotListing"
    ? type.startsWith("lot-listing-")
    : type.startsWith("asset-");
}

function validateEnsuredOutboxJob(
  outbox: ReportJobOutbox,
  job: IReportJob | null
) {
  if (
    !job ||
    job.type !== outbox.type ||
    String(job.reportId || "") !== String(outbox.reportId || "") ||
    String(job.progressId || "") !== String(outbox.progressId || "") ||
    String(job.idempotencyKey || "") !== outbox.idempotencyKey ||
    String(job.targetStatus || "") !== String(outbox.targetStatus || "") ||
    reportJobPayloadFingerprint(job.payload) !==
      reportJobPayloadFingerprint(outbox.payload)
  ) {
    throw Object.assign(
      new Error("The report job outbox resolved to a conflicting durable job."),
      { code: "REPORT_JOB_OUTBOX_IDENTITY_CONFLICT" }
    );
  }
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Mongo/Mongoose can cast explicit `undefined` values nested in a Mixed field
 * to `null` during an upsert. Strip them before persistence so the payload we
 * fingerprint is exactly the payload workers later receive. Non-plain values
 * (Buffer, Date, ObjectId, BSON values) retain their runtime representation.
 */
function normalizeReportJobPayloadForStorage(value: any): any {
  if (value === undefined || value === null || typeof value !== "object") {
    return value;
  }
  if (value instanceof Date || Buffer.isBuffer(value)) return value;
  if (Array.isArray(value)) {
    return value.map((item) =>
      item === undefined ? null : normalizeReportJobPayloadForStorage(item),
    );
  }
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, normalizeReportJobPayloadForStorage(value[key])]),
  );
}

function canonicalReportJobPayload(value: any): any {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return { $buffer: value.toString("base64") };
  if (typeof value.toHexString === "function") {
    return { $objectId: String(value.toHexString()) };
  }
  if (Array.isArray(value)) {
    return value.map((item) =>
      item === undefined ? null : canonicalReportJobPayload(item),
    );
  }
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, canonicalReportJobPayload(value[key])]),
  );
}

function reportJobPayloadFingerprint(payload: unknown): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        canonicalReportJobPayload(
          normalizeReportJobPayloadForStorage(payload),
        ),
      ),
    )
    .digest("hex");
}

function assertExistingReportJobIdentity(
  input: CreateReportJobInput,
  existing: IReportJob,
) {
  if (
    existing.type !== input.type ||
    String(existing.reportId || "") !== String(input.reportId || "") ||
    String(existing.progressId || "") !== String(input.progressId || "") ||
    String(existing.idempotencyKey || "") !== String(input.idempotencyKey || "") ||
    String(existing.targetStatus || "") !== String(input.targetStatus || "") ||
    reportJobPayloadFingerprint(existing.payload) !==
      reportJobPayloadFingerprint(input.payload)
  ) {
    throw Object.assign(
      new Error(
        "The report job idempotency key already belongs to a different immutable job payload.",
      ),
      { code: "REPORT_JOB_IDENTITY_CONFLICT", statusCode: 409 },
    );
  }
}

/**
 * Ensure one embedded report-job intent exists in the durable queue. Clearing
 * is token-CAS guarded, so a concurrent/newer report transition is preserved.
 */
export async function ensureReportJobOutbox(
  kind: ReportJobOutboxModelKind,
  reportId: string,
  expectedToken?: string
): Promise<IReportJob | null> {
  const Model = reportModelForOutbox(kind);
  const report: any = await Model.findOne({
    _id: reportId,
    ...(expectedToken
      ? { "report_job_outbox.token": expectedToken }
      : { "report_job_outbox.token": { $type: "string" } }),
  })
    .select("+report_job_outbox")
    .lean();
  const raw = report?.report_job_outbox;
  if (!raw) return null;
  const outbox = raw as ReportJobOutbox;
  if (
    !outbox.token ||
    !outbox.idempotencyKey ||
    !outbox.type ||
    !outboxTypeMatchesModel(kind, outbox.type) ||
    String(outbox.reportId || "") !== String(reportId) ||
    (expectedToken && String(outbox.token) !== String(expectedToken))
  ) {
    throw Object.assign(new Error("The embedded report job outbox is invalid."), {
      code: "INVALID_REPORT_JOB_OUTBOX",
    });
  }

  const job = await createMongoReportJob({
    type: outbox.type,
    reportId: outbox.reportId,
    progressId: outbox.progressId,
    payload: outbox.payload,
    priority: outbox.priority,
    maxAttempts: outbox.maxAttempts,
    idempotencyKey: outbox.idempotencyKey,
    targetStatus: outbox.targetStatus,
  });
  validateEnsuredOutboxJob(outbox, job);
  // A stop can win after the outbox read but before job creation. Keep the
  // exact late-arriving Salvage job terminal; the parent tombstone also fences
  // a worker that claimed it in this interval.
  if (job && kind === "salvage" && !await SalvageReport.exists({ _id: reportId, job_id: outbox.token, job_status: { $ne: "cancelled" } })) {
    await ReportJob.updateOne({ _id: job._id, status: { $in: ["queued", "processing"] } },
      { $set: { status: "cancelled", completedAt: new Date(), lastError: "Processing stopped or superseded by a newer run." },
        $unset: { lockedBy: 1, executionToken: 1, leaseUntil: 1, dedupeKey: 1 } });
  }
  await Model.updateOne(
    { _id: reportId, "report_job_outbox.token": outbox.token },
    { $unset: { report_job_outbox: 1 } }
  );
  return job;
}

async function reconcilePendingReportJobOutboxes(
  supportedTypes: ReportJobType[]
) {
  // Unit/library callers can run the worker without a connected database.
  // Production bootstrap connects first; skip scanning until that boundary.
  if (ReportJob.db.readyState !== 1) return;
  for (const [kind, RawModel] of [
    ["asset", AssetReport],
    ["lotListing", LotListing],
    ["salvage", SalvageReport],
  ] as const) {
    const Model: any = RawModel;
    let query: any = Model.find({
      "report_job_outbox.token": { $type: "string" },
      "report_job_outbox.type": { $in: supportedTypes },
    })
      .select("+report_job_outbox")
      .sort({ "report_job_outbox.createdAt": 1 });
    // Keep the production scan bounded while remaining compatible with small
    // model doubles used by worker lifecycle tests.
    if (typeof query.limit === "function") query = query.limit(25);
    const reports: any[] = await query.lean();
    for (const report of reports) {
      await ensureReportJobOutbox(
        kind,
        String(report._id),
        String(report.report_job_outbox?.token || "")
      ).catch((error) => {
        console.error("[ReportWorker] Report job outbox reconciliation failed:", {
          kind,
          reportId: String(report._id),
          error: summarizeError(error),
        });
      });
    }
  }
}

export type ReportJobExecutionContext = {
  executionToken: string;
  signal: AbortSignal;
  assertOwned: () => Promise<void>;
};

export type ReportJobHandler = (
  job: IReportJob,
  context: ReportJobExecutionContext
) => Promise<void>;

type ActiveReportJobExecution = {
  jobId: string;
  executionToken: string;
};

const activeReportJobExecution =
  new AsyncLocalStorage<ActiveReportJobExecution>();

export class ReportJobOwnershipLostError extends Error {
  readonly code = "REPORT_JOB_OWNERSHIP_LOST";

  constructor(jobId: string) {
    super(`Report job ${jobId} is no longer owned by this execution attempt.`);
    this.name = "ReportJobOwnershipLostError";
  }
}

// Auxiliary jobs belong to a report but must never mutate its approval,
// release, generation, or owner-notification state when they retry or fail.
function isAuxiliaryReportJob(type: ReportJobType): boolean {
  return type === "released-appraisal-analysis";
}

function ownsMultipartSourceFiles(type: ReportJobType): boolean {
  return type === "asset-preview" || type === "lot-listing-preview";
}

async function cleanupOwnedReportJobSourceFiles(job: IReportJob): Promise<void> {
  if (!ownsMultipartSourceFiles(job.type)) return;
  await cleanupReportJobSourceFiles([
    ...deserializeMulterFiles((job.payload as any)?.images),
    ...deserializeMulterFiles((job.payload as any)?.videos),
  ]);
}

function uploadSessionTypeForJob(
  type: ReportJobType,
): "asset" | "lotListing" | null {
  if (type === "asset-preview") return "asset";
  if (type === "lot-listing-preview") return "lotListing";
  return null;
}

async function reconcileUploadSessionJobTerminalState(
  job: IReportJob,
  status: "processed" | "failed",
  message?: string,
) {
  const type = uploadSessionTypeForJob(job.type);
  if (!type || !job.reportId) return;
  const update =
    status === "processed"
      ? {
          $set: { status },
          $unset: { activeContractClaim: 1, lastError: 1 },
        }
      : {
          $set: { status, ...(message ? { lastError: message } : {}) },
          $unset: { activeContractClaim: 1 },
        };
  await ReportUploadSession.updateMany(
    {
      reportId: String(job.reportId),
      type,
      status: { $ne: "processed" },
      cleanupStartedAt: { $exists: false },
    },
    update,
  );
}

async function hasCompletedReportGeneration(job: IReportJob): Promise<boolean> {
  if (!job.reportId || isAuxiliaryReportJob(job.type)) return false;
  const generationToken = reportGenerationToken(job);
  if (!generationToken) return false;
  const filter = {
    _id: job.reportId,
    job_id: generationToken,
    job_status: "done",
  };
  const report: any = job.type.startsWith("lot-listing-")
    ? await LotListing.findOne(filter).lean()
    : job.type.startsWith("salvage-")
      ? await SalvageReport.findOne(filter).lean()
    : job.type.startsWith("asset-")
      ? await AssetReport.findOne(filter).lean()
      : null;
  if (!report) return false;
  if (job.type === "salvage-files") {
    return report.files_stale !== true && hasRequiredReportFiles("salvage", report.files);
  }

  if (job.type === "asset-preview-files") {
    return hasRequiredReportFiles(
      "asset",
      report.preview_files,
      report.files,
    );
  }
  if (job.type === "lot-listing-files") {
    return (
      report.artifact_repair_required !== true &&
      hasRequiredReportFiles(
        "lotListing",
        report.preview_files,
        report.files,
      )
    );
  }
  if (
    job.type === "asset-excel-cr-files" ||
    job.type === "lot-listing-excel-cr-files"
  ) {
    return [report.preview_files, report.files].some((source: any) =>
      [source?.excel, source?.xlsx].some(
        (value) => typeof value === "string" && value.trim().length > 0,
      ),
    );
  }
  if (job.type === "asset-preview" || job.type === "lot-listing-preview") {
    // Initial-preview handlers persist the report's terminal `done` state only
    // after the complete preview snapshot has been committed. An empty lots
    // array is still a valid persisted result (and, more importantly, must not
    // let an expired worker regress an already-completed generation).
    return true;
  }
  return true;
}

async function completeTerminalReconciliation(
  job: IReportJob,
  input: {
    workerId: string;
    executionToken: string;
    completedAt?: Date;
  },
): Promise<IReportJob | null> {
  const completedAt = input.completedAt || new Date();
  return ReportJob.findOneAndUpdate(
    {
      _id: job._id,
      status: "processing",
      lockedBy: input.workerId,
      attempts: job.attempts,
      executionToken: input.executionToken,
    },
    {
      $set: {
        status: "completed",
        completedAt,
        "progress.phase": "done",
        "progress.stage": "ready",
        "progress.progressPercent": 100,
        "progress.serverProgress01": 1,
        "progress.updatedAt": completedAt.toISOString(),
        "progress.message": "Completed",
      },
      $unset: {
        dedupeKey: 1,
        leaseUntil: 1,
        lockedBy: 1,
        executionToken: 1,
        lastError: 1,
        failedAt: 1,
      },
    },
    { returnDocument: "after" },
  );
}

async function finishTerminalFailure(
  job: IReportJob,
  input: {
    workerId: string;
    executionToken: string;
    message: string;
    failedAt?: Date;
  },
): Promise<IReportJob | null> {
  const failedAt = input.failedAt || new Date();
  return ReportJob.findOneAndUpdate(
    {
      _id: job._id,
      status: "processing",
      lockedBy: input.workerId,
      attempts: job.attempts,
      executionToken: input.executionToken,
    },
    {
      $set: {
        status: "failed",
        failedAt,
        lastError: input.message,
        "progress.phase": "error",
        "progress.stage": "error",
        "progress.updatedAt": failedAt.toISOString(),
        "progress.message": input.message,
      },
      $unset: {
        dedupeKey: 1,
        leaseUntil: 1,
        lockedBy: 1,
        executionToken: 1,
      },
    },
    { returnDocument: "after" },
  );
}

function reportGenerationToken(job: IReportJob): string {
  if (
    !job.type.startsWith("asset-") &&
    !job.type.startsWith("salvage-") &&
    !job.type.startsWith("lot-listing-")
  ) {
    return "";
  }
  return String(
    job.payload?.generationToken ||
      // Lot Listing file jobs created by older releases used jobId.
      job.payload?.jobId ||
      // Initial preview jobs persist their logical report claim as progressId.
      job.payload?.progressId ||
      job.progressId ||
      ""
  ).trim();
}

// Initial preview jobs can finish analysis before optional delivery artifacts.
// Keep that durable preview visible if a later artifact step exhausts its retries.
async function hasSavedPreviewLots(
  type: ReportJobType,
  reportId?: string
): Promise<boolean> {
  if (!reportId || !type.endsWith("-preview")) return false;
  if (type === "salvage-preview") return false;
  const filter = {
    _id: reportId,
    "preview_data.lots.0": { $exists: true },
  };
  return Boolean(
    type.startsWith("lot-listing")
      ? await LotListing.exists(filter)
      : await AssetReport.exists(filter)
  );
}

export function shouldUseMongoReportQueue(): boolean {
  // Production report work must survive process restarts. The memory queue is
  // intentionally limited to local development and tests.
  if (process.env.NODE_ENV === "production") return true;
  const backend = String(process.env.REPORT_QUEUE_BACKEND || "").toLowerCase();
  if (backend === "memory") return false;
  if (backend === "mongo" || backend === "mongodb") return true;
  return ["api", "worker"].includes(
    String(process.env.REPORT_PROCESS_ROLE || "").toLowerCase()
  );
}

export async function createMongoReportJob(input: CreateReportJobInput) {
  const dedupeKey = input.reportId ? `${input.type}:${input.reportId}` : undefined;
  const reportType =
    input.type.startsWith("salvage-") ? "Salvage" : input.type === "auctioneer-delivery"
      ? "auctioneer"
      : input.type.startsWith("lot-listing")
        ? "lotListing"
        : "asset";
  const values = {
    type: input.type,
    reportId: input.reportId,
    progressId: input.progressId,
    dedupeKey,
    idempotencyKey: input.idempotencyKey,
    payload: normalizeReportJobPayloadForStorage(input.payload),
    priority: input.priority ?? 0,
    maxAttempts: input.maxAttempts ?? 2,
    targetStatus: input.targetStatus,
    status: "queued" as const,
    queuedAt: new Date(),
    progress: {
      phase: "processing" as const,
      serverProgress01: 0,
      message: "Queued",
      stage: "queued" as const,
      progressPercent: 0,
      updatedAt: new Date().toISOString(),
      result: input.reportId
        ? { reportId: input.reportId, reportType, status: "processing" }
        : undefined,
    } satisfies ReportJobProgress,
  };

  if (input.idempotencyKey) {
    const existing = await ReportJob.findOne({ idempotencyKey: input.idempotencyKey });
    if (existing) {
      assertExistingReportJobIdentity(input, existing);
      const explicitEventRetry = ["asset-preview", "lot-listing-preview"].includes(input.type) &&
        input.targetStatus === "preview" && input.maxAttempts === 1 && existing.maxAttempts === 1 &&
        input.payload?.eventIdentityRetry?.version === 1 &&
        /^[a-f\d]{24}$/i.test(String(input.payload.eventIdentityRetry.originalJobId || "")) &&
        String(input.progressId || "").startsWith("event-retry-");
      // This one-attempt manual source retry may already have failed while the
      // API was unable to clear its accepted outbox. A later sweep must record
      // that exact terminal receipt, not authorize another paid analysis call.
      if (existing.status !== "failed" || explicitEventRetry) return existing;
      const revived = await ReportJob.findOneAndUpdate(
        { _id: existing._id, status: "failed" },
        {
          $set: { ...values, attempts: 0 },
          $unset: {
            failedAt: 1,
            completedAt: 1,
            startedAt: 1,
            lastError: 1,
            leaseUntil: 1,
            lockedBy: 1,
            executionToken: 1,
            failureNotificationSentAt: 1,
          },
        },
        { returnDocument: "after" }
      );
      if (revived) {
        assertExistingReportJobIdentity(input, revived);
        return revived;
      }
      const current = await ReportJob.findById(existing._id);
      if (current) assertExistingReportJobIdentity(input, current);
      return current;
    }
  }

  if (!dedupeKey && !input.idempotencyKey) return ReportJob.create(values);

  try {
    const ensured = await ReportJob.findOneAndUpdate(
      input.idempotencyKey
        ? { idempotencyKey: input.idempotencyKey }
        : { dedupeKey },
      { $setOnInsert: values },
      { upsert: true, returnDocument: "after", setDefaultsOnInsert: true }
    );
    if (ensured) assertExistingReportJobIdentity(input, ensured);
    return ensured;
  } catch (error: any) {
    // A concurrent idempotent completion can win the unique-key race.
    if (error?.code === 11000) {
      const existing = await ReportJob.findOne(
        input.idempotencyKey
          ? { idempotencyKey: input.idempotencyKey }
          : { dedupeKey }
      );
      if (existing) {
        assertExistingReportJobIdentity(input, existing);
        return existing;
      }
    }
    throw error;
  }
}

export async function updateMongoReportJobProgress(
  progressId: string | undefined,
  patch: ReportJobProgress
) {
  if (!progressId || !shouldUseMongoReportQueue()) return;
  const normalizedPatch = {
    ...patch,
    progressPercent:
      typeof patch.progressPercent === "number"
        ? Math.max(0, Math.min(100, patch.progressPercent))
        : typeof patch.serverProgress01 === "number"
          ? Math.max(0, Math.min(100, patch.serverProgress01 * 100))
          : undefined,
    updatedAt: new Date().toISOString(),
  };
  const activeExecution = activeReportJobExecution.getStore();
  await ReportJob.findOneAndUpdate(
    activeExecution
      ? {
          _id: activeExecution.jobId,
          progressId,
          status: "processing",
          executionToken: activeExecution.executionToken,
        }
      : { progressId },
    {
      $set: Object.fromEntries(
        Object.entries(normalizedPatch)
          .filter(([, value]) => value !== undefined)
          .map(([key, value]) => [`progress.${key}`, value])
      ),
    },
    activeExecution ? {} : { sort: { createdAt: -1 } }
  );
}

export async function endMongoReportJobProgress(
  progressId: string | undefined,
  ok: boolean,
  message?: string
) {
  await updateMongoReportJobProgress(progressId, {
    phase: ok ? "done" : "error",
    serverProgress01: ok ? 1 : undefined,
    message,
  });
}

export async function getMongoReportJobProgress(progressId: string) {
  return ReportJob.findOne({ progressId }).sort({ createdAt: -1 }).lean();
}

async function markOwnedSmartUploadClassificationFailed(
  job: IReportJob,
  message: string
) {
  if (job.type !== "smart-upload-classify") return;
  const sessionId = String(job.payload?.sessionId || "");
  const classificationJobId = String(
    job.payload?.classificationJobId || job._id || ""
  );
  const revision = Number.isFinite(Number(job.payload?.classificationRevision))
    ? Number(job.payload?.classificationRevision)
    : 0;
  if (!sessionId || !classificationJobId) return;
  const revisionFilter =
    revision === 0
      ? {
          $or: [
            { "smartGrouping.revision": 0 },
            { "smartGrouping.revision": { $exists: false } },
            { "smartGrouping.revision": null },
          ],
        }
      : { "smartGrouping.revision": revision };
  await ReportUploadSession.findOneAndUpdate(
    {
      _id: sessionId,
      smartUpload: true,
      cleanupStartedAt: { $exists: false },
      "smartGrouping.status": "classifying",
      "smartGrouping.classificationJobId": classificationJobId,
      ...revisionFilter,
    },
    {
      $set: {
        "smartGrouping.status": "failed",
        "smartGrouping.error": message,
      },
    }
  );
}

async function claimNextJob(
  workerId: string,
  supportedTypes: ReportJobType[],
  leaseMs: number
) {
  const now = new Date();
  const leaseUntil = new Date(now.getTime() + leaseMs);
  const executionToken = randomUUID();

  const exhaustedCandidates = await ReportJob.find({
    type: { $in: supportedTypes },
    status: "processing",
    leaseUntil: { $lte: now },
    $expr: { $gte: ["$attempts", "$maxAttempts"] },
  })
    .sort({ leaseUntil: 1 })
    .limit(25);
  for (const candidate of exhaustedCandidates) {
    const message = "The processing worker stopped after the final allowed attempt.";
    const expiredExecutionToken = String(candidate.executionToken || "").trim();
    const expiredJob = await ReportJob.findOneAndUpdate(
      {
        _id: candidate._id,
        status: "processing",
        leaseUntil: { $lte: now },
        attempts: candidate.attempts,
        ...(expiredExecutionToken
          ? { executionToken: expiredExecutionToken }
          : { executionToken: null }),
        $expr: { $gte: ["$attempts", "$maxAttempts"] },
      },
      {
        $set: {
          // Keep the job processing and lease-owned until report/session
          // reconciliation and source cleanup finish. Exposing `failed` here
          // lets an API retry revive the same row while this worker is still
          // projecting terminal state and deleting the retry's source files.
          lockedBy: workerId,
          executionToken,
          leaseUntil,
          lastError: message,
          "progress.phase": "error",
          "progress.stage": "error",
          "progress.updatedAt": now.toISOString(),
          "progress.message": message,
        },
      },
      { returnDocument: "after" }
    );
    // Multiple workers may observe the same expired row. Only the process
    // that wins this CAS owns report reconciliation, cleanup, and notification.
    if (!expiredJob) continue;
    const isAuctioneerDelivery = expiredJob.type === "auctioneer-delivery";
    const isFileGenerationJob = expiredJob.type.endsWith("-files");
    let reportFailureTransitioned = !expiredJob.reportId;
    let terminalProjectionFailed = false;
    await markOwnedSmartUploadClassificationFailed(expiredJob, message).catch(
      (error) => {
        terminalProjectionFailed = true;
        console.error(
          "[ReportWorker] Expired Smart Upload reconciliation failed:",
          error
        );
      }
    );
    if (isAuctioneerDelivery && expiredJob.payload?.workItemId) {
      await AuctioneerWorkItem.updateOne(
        {
          _id: String(expiredJob.payload.workItemId),
          "delivery.status": { $in: ["queued", "sending"] },
        },
        {
          $set: {
            "delivery.status": "failed",
            "delivery.failedAt": now,
            "delivery.lastError":
              "The delivery worker stopped before the current step was confirmed. Retry will resume from its saved checkpoints.",
          },
        }
      ).catch((error) => {
        terminalProjectionFailed = true;
        console.error(
          "[ReportWorker] Expired Auctioneer delivery reconciliation failed:",
          error
        );
      });
    }
    if (
      expiredJob.reportId &&
      !isAuctioneerDelivery &&
      !isAuxiliaryReportJob(expiredJob.type)
    ) {
      try {
        const preserveSavedPreview =
          !isFileGenerationJob &&
          (await hasSavedPreviewLots(expiredJob.type, expiredJob.reportId));
        const update = {
          $set: {
            ...(!isFileGenerationJob
              ? { status: preserveSavedPreview ? "preview" : "error" }
              : {}),
            files_generating: false,
            files_regenerating: false,
            job_status: "error",
            job_error: message,
            processing_completed_at: now,
            // Only advance worker-owned leaves. Controllers also persist durable
            // retry metadata (for example previousStatus and previewFingerprint)
            // in this object; replacing it here would make an expired job alter
            // the logical submission it is supposed to reconcile.
            "generation_progress.stage": "error",
            "generation_progress.progressPercent": 100,
            "generation_progress.message": message,
            "generation_progress.updatedAt": now,
          },
          $unset: {
            job_execution_token: 1,
            ...(expiredJob.type.startsWith("lot-listing")
              ? {
                  artifact_publish_token: 1,
                  artifact_publish_generation_token: 1,
                  artifact_publish_expires_at: 1,
                  artifact_repair_required: 1,
                }
              : {}),
          },
        } as any;
        const generationToken = reportGenerationToken(expiredJob);
        const reportFilter = {
          _id: expiredJob.reportId,
          $or: [
            ...(expiredExecutionToken
              ? [{ job_execution_token: expiredExecutionToken }]
              : []),
            { job_execution_token: { $exists: false } },
            { job_execution_token: null },
          ],
          ...(generationToken
            ? {
                job_id: generationToken,
                job_status: { $ne: "done" },
              }
            : {}),
        };
        if (expiredJob.type.startsWith("lot-listing")) {
          reportFailureTransitioned = Boolean(
            await LotListing.findOneAndUpdate(reportFilter, update)
          );
        } else if (expiredJob.type.startsWith("salvage-")) {
          reportFailureTransitioned = Boolean(await SalvageReport.findOneAndUpdate(reportFilter, update));
        } else {
          reportFailureTransitioned = Boolean(
            await AssetReport.findOneAndUpdate(reportFilter, update)
          );
        }
      } catch (error) {
        terminalProjectionFailed = true;
        console.error(
          "[ReportWorker] Expired report reconciliation failed:",
          error
        );
      }
    }

    // The expired attempt can persist its final report immediately after our
    // first completion check but before the failure projection above. Resolve
    // that race from the exact generation before exposing a failed queue row.
    if (await hasCompletedReportGeneration(expiredJob)) {
      try {
        await reconcileUploadSessionJobTerminalState(
          expiredJob,
          "processed",
        );
      } catch (error) {
        console.error(
          "[ReportWorker] Completed upload-session reconciliation failed:",
          error,
        );
        continue;
      }
      await cleanupOwnedReportJobSourceFiles(expiredJob).catch(
        (cleanupError) => {
          console.error(
            "[ReportWorker] Completed source-file cleanup failed:",
            cleanupError,
          );
        },
      );
      await completeTerminalReconciliation(expiredJob, {
        workerId,
        executionToken,
        completedAt: now,
      });
      continue;
    }

    if (terminalProjectionFailed) {
      // Keep the job and its source files lease-owned. Once this lease expires,
      // reconciliation retries the exact terminal projection instead of
      // exposing a failed job whose report still appears to be processing.
      continue;
    }

    try {
      await reconcileUploadSessionJobTerminalState(
        expiredJob,
        "failed",
        message,
      );
    } catch (error) {
      console.error(
        "[ReportWorker] Expired upload-session reconciliation failed:",
        error,
      );
      continue;
    }
    if (!isAuctioneerDelivery && !isAuxiliaryReportJob(expiredJob.type)) {
      await cleanupOwnedReportJobSourceFiles(expiredJob).catch((cleanupError) => {
        console.error("[ReportWorker] Expired source-file cleanup failed:", cleanupError);
      });
      if (
        reportFailureTransitioned &&
        expiredJob.payload?.notifyOwnerOnFailure !== false
      ) {
        await notifyReportProcessingFailure(expiredJob, message).catch((error) => {
          console.error("[ReportWorker] Failure notification error:", error);
        });
      }
    }
    await finishTerminalFailure(expiredJob, {
      workerId,
      executionToken,
      message,
      failedAt: now,
    });
  }

  return ReportJob.findOneAndUpdate(
    {
      type: { $in: supportedTypes },
      $expr: { $lt: ["$attempts", "$maxAttempts"] },
      $or: [
        { status: "queued" },
        { status: "processing", leaseUntil: { $lte: now } },
      ],
    },
    {
      $set: {
        status: "processing",
        lockedBy: workerId,
        executionToken,
        leaseUntil,
        startedAt: now,
        "progress.phase": "processing",
        "progress.stage": "analyzing",
        "progress.updatedAt": now.toISOString(),
        "progress.message": "Processing",
      },
      $inc: { attempts: 1 },
    },
    {
      sort: { priority: -1, queuedAt: 1 },
      returnDocument: "after",
    }
  );
}

async function completeJob(
  jobId: string,
  workerId: string,
  attempts: number,
  executionToken: string
): Promise<boolean> {
  const completed = await ReportJob.findOneAndUpdate(
    {
      _id: jobId,
      status: "processing",
      lockedBy: workerId,
      attempts,
      executionToken,
    },
    {
      $set: {
        status: "completed",
        completedAt: new Date(),
        "progress.phase": "done",
        "progress.stage": "ready",
        "progress.progressPercent": 100,
        "progress.updatedAt": new Date().toISOString(),
        "progress.serverProgress01": 1,
        "progress.message": "Completed",
      },
      $unset: {
        dedupeKey: 1,
        leaseUntil: 1,
        lockedBy: 1,
        executionToken: 1,
      },
    },
    { returnDocument: "after" }
  );
  return Boolean(completed);
}

async function renewJobLease(
  jobId: string,
  workerId: string,
  attempts: number,
  executionToken: string,
  leaseMs: number
): Promise<boolean> {
  const result = await ReportJob.updateOne(
    {
      _id: jobId,
      status: "processing",
      lockedBy: workerId,
      attempts,
      executionToken,
    },
    {
      $set: {
        leaseUntil: new Date(Date.now() + leaseMs),
      },
    }
  );
  return result.matchedCount === 1;
}

async function failJob(
  job: IReportJob,
  error: unknown,
  workerId: string,
  executionToken: string,
  leaseMs: number,
): Promise<boolean> {
  const message = error instanceof Error ? error.message : String(error);
  const canRetry = job.attempts < job.maxAttempts;
  const isAuctioneerDelivery = job.type === "auctioneer-delivery";
  const isFileGenerationJob = job.type.endsWith("-files");
  let reportFailureTransitioned = !job.reportId;
  let terminalProjectionFailed = false;
  const transitionAt = new Date();
  const failed = await ReportJob.findOneAndUpdate(
    {
      _id: job._id,
      status: "processing",
      lockedBy: workerId,
      attempts: job.attempts,
      executionToken,
    },
    {
      $set: {
        // Keep a terminal failure lease-owned until report/session projection
        // and source cleanup finish. Publishing `failed` early lets a retry
        // revive this row while the previous attempt still deletes its inputs.
        status: canRetry ? "queued" : "processing",
        ...(!canRetry
          ? { leaseUntil: new Date(transitionAt.getTime() + leaseMs) }
          : {}),
        lastError: message,
        "progress.phase": canRetry ? "processing" : "error",
        "progress.stage": canRetry ? "queued" : "error",
        "progress.updatedAt": new Date().toISOString(),
        "progress.message": canRetry ? `Retrying after error: ${message}` : message,
      },
      $unset: {
        ...(canRetry
          ? {
              leaseUntil: 1,
              lockedBy: 1,
              executionToken: 1,
              failedAt: 1,
            }
          : { failedAt: 1 }),
      },
    },
    { returnDocument: "after" }
  );

  if (!failed) {
    console.warn(
      `[ReportWorker] Ignored stale failure for ${job.type} ${String(job._id)}`
    );
    return false;
  }

  if (!canRetry) {
    if (await hasCompletedReportGeneration(failed)) {
      try {
        await reconcileUploadSessionJobTerminalState(failed, "processed");
      } catch (reconciliationError) {
        console.error(
          "[ReportWorker] Completed upload-session reconciliation failed:",
          reconciliationError,
        );
        return false;
      }
      await cleanupOwnedReportJobSourceFiles(failed).catch((cleanupError) => {
        console.error(
          "[ReportWorker] Completed source-file cleanup failed:",
          cleanupError,
        );
      });
      return Boolean(
        await completeTerminalReconciliation(failed, {
          workerId,
          executionToken,
          completedAt: transitionAt,
        }),
      );
    }
    await markOwnedSmartUploadClassificationFailed(job, message).catch(
      (reconciliationError) => {
        terminalProjectionFailed = true;
        console.error(
          "[ReportWorker] Smart Upload failure reconciliation failed:",
          reconciliationError
        );
      }
    );
  }

  if (isAuctioneerDelivery && job.payload?.workItemId) {
    await AuctioneerWorkItem.updateOne(
      {
        _id: String(job.payload.workItemId),
        "delivery.status": { $in: ["queued", "sending"] },
      },
      {
        $set: {
          "delivery.status": canRetry ? "queued" : "failed",
          ...(canRetry ? {} : { "delivery.failedAt": new Date() }),
          "delivery.lastError": canRetry
            ? "Retrying the Auctioneer delivery from its saved checkpoints."
            : message,
        },
      }
    ).catch((reconciliationError) => {
      if (!canRetry) terminalProjectionFailed = true;
      console.error(
        "[ReportWorker] Auctioneer delivery failure reconciliation failed:",
        reconciliationError
      );
    });
  }

  if (
    job.reportId &&
    !isAuctioneerDelivery &&
    !isAuxiliaryReportJob(job.type)
  ) {
    try {
      const preserveSavedPreview =
        !isFileGenerationJob &&
        (await hasSavedPreviewLots(job.type, job.reportId));
      const update = {
        $set: canRetry
          ? {
              status:
                !isFileGenerationJob && preserveSavedPreview
                  ? "preview"
                  : "processing",
              files_generating: true,
              ...(isFileGenerationJob ? { files_regenerating: true } : {}),
              job_status: "queued",
              job_error: `Retrying after error: ${message}`,
              queued_at: new Date(),
              "generation_progress.stage": "queued",
              "generation_progress.progressPercent": Number(
                job.progress?.progressPercent || 0
              ),
              "generation_progress.message": `Retrying after error: ${message}`,
              "generation_progress.updatedAt": new Date(),
            }
          : {
              ...(!isFileGenerationJob
                ? { status: preserveSavedPreview ? "preview" : "error" }
                : {}),
              files_generating: false,
              files_regenerating: false,
              job_status: "error",
              job_error: message,
              processing_completed_at: new Date(),
              "generation_progress.stage": "error",
              "generation_progress.progressPercent": 100,
              "generation_progress.message": message,
              "generation_progress.updatedAt": new Date(),
            },
        $unset: {
          job_execution_token: 1,
          ...(!canRetry && job.type.startsWith("lot-listing")
            ? {
                artifact_publish_token: 1,
                artifact_publish_generation_token: 1,
                artifact_publish_expires_at: 1,
                artifact_repair_required: 1,
              }
            : {}),
        },
      } as any;
      const generationToken = reportGenerationToken(job);
      const reportFilter = {
        _id: job.reportId,
        // A new attempt can claim immediately after the ReportJob CAS above.
        // Match either this execution or a legacy report that has not adopted
        // attempt fencing; never regress a report already claimed by the retry.
        $or: [
          { job_execution_token: executionToken },
          { job_execution_token: { $exists: false } },
          { job_execution_token: null },
        ],
        ...(generationToken
          ? {
              job_id: generationToken,
              job_status: { $ne: "done" },
            }
          : {}),
      };
      if (job.type.startsWith("lot-listing")) {
        reportFailureTransitioned = Boolean(
          await LotListing.findOneAndUpdate(reportFilter, update)
        );
      } else if (job.type.startsWith("salvage-")) {
        reportFailureTransitioned = Boolean(await SalvageReport.findOneAndUpdate(reportFilter, update));
      } else {
        reportFailureTransitioned = Boolean(
          await AssetReport.findOneAndUpdate(reportFilter, update)
        );
      }
    } catch (reconciliationError) {
      if (!canRetry) terminalProjectionFailed = true;
      console.error(
        "[ReportWorker] Report failure reconciliation failed:",
        reconciliationError
      );
    }
  }
  if (!canRetry && terminalProjectionFailed) {
    // Leave the exact job/source lease intact. Expiry reconciliation can retry
    // the failed domain projection without reviving a half-terminal job.
    return false;
  }
  if (!canRetry && (await hasCompletedReportGeneration(failed))) {
    try {
      await reconcileUploadSessionJobTerminalState(failed, "processed");
    } catch (reconciliationError) {
      console.error(
        "[ReportWorker] Completed upload-session reconciliation failed:",
        reconciliationError,
      );
      return false;
    }
    await cleanupOwnedReportJobSourceFiles(failed).catch((cleanupError) => {
      console.error(
        "[ReportWorker] Completed source-file cleanup failed:",
        cleanupError,
      );
    });
    return Boolean(
      await completeTerminalReconciliation(failed, {
        workerId,
        executionToken,
        completedAt: transitionAt,
      }),
    );
  }
  if (!canRetry && !isAuctioneerDelivery && !isAuxiliaryReportJob(job.type)) {
    await reconcileUploadSessionJobTerminalState(job, "failed", message);
    await cleanupOwnedReportJobSourceFiles(job).catch((cleanupError) => {
      console.error("[ReportWorker] Final source-file cleanup failed:", cleanupError);
    });
    if (
      reportFailureTransitioned &&
      job.payload?.notifyOwnerOnFailure !== false
    ) {
      await notifyReportProcessingFailure(job, message).catch((notificationError) => {
        console.error("[ReportWorker] Failure notification error:", notificationError);
      });
    }
  }
  if (!canRetry) {
    return Boolean(
      await finishTerminalFailure(failed, {
        workerId,
        executionToken,
        message,
        failedAt: transitionAt,
      }),
    );
  }
  return true;
}

function sleepUntilPollOrShutdown(ms: number, signal: AbortSignal) {
  if (signal.aborted) return Promise.resolve();

  return new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
    // Abort can occur after the initial check but before listener registration.
    // Recheck after subscribing so that narrow race cannot retain a full poll.
    if (signal.aborted) finish();
  });
}

export type StartMongoReportWorkerOptions = {
  signal?: AbortSignal;
};

export async function startMongoReportWorker(
  handlers: Partial<Record<ReportJobType, ReportJobHandler>>,
  options: StartMongoReportWorkerOptions = {}
) {
  const supportedTypes = Object.keys(handlers) as ReportJobType[];
  if (supportedTypes.length === 0) {
    throw new Error("Report worker started without job handlers.");
  }

  const workerId =
    process.env.REPORT_WORKER_ID ||
    `${os.hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`;
  const concurrency = getPositiveIntEnv("REPORT_JOB_CONCURRENCY", 2);
  const pollMs = getPositiveIntEnv("REPORT_JOB_POLL_MS", 1000);
  const leaseMs = getPositiveIntEnv("REPORT_JOB_LEASE_MS", 3 * 60 * 1000);
  const defaultHeartbeatMs = Math.max(5000, Math.min(60 * 1000, Math.floor(leaseMs / 3)));
  const configuredHeartbeatMs = getPositiveIntEnv(
    "REPORT_JOB_HEARTBEAT_MS",
    defaultHeartbeatMs
  );
  const heartbeatMs = Math.max(
    5000,
    Math.min(configuredHeartbeatMs, Math.max(5000, Math.floor(leaseMs / 2)))
  );
  const shutdownController = new AbortController();
  let stopping = options.signal?.aborted ?? false;

  const stop = () => {
    stopping = true;
    shutdownController.abort();
  };
  if (options.signal) {
    options.signal.addEventListener("abort", stop, { once: true });
    if (options.signal.aborted) stop();
  } else {
    // Backward-compatible ownership for direct library callers. The production
    // entry point supplies a signal so it can also disconnect and exit PM2.
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  }

  console.log(
    `[ReportWorker] Starting ${workerId} with concurrency ${concurrency}; types: ${supportedTypes.join(", ")}`
  );

  async function workerLoop(slot: number) {
    while (!stopping) {
      let job: IReportJob | null;
      try {
        await reconcilePendingReportJobOutboxes(supportedTypes);
        job = await claimNextJob(workerId, supportedTypes, leaseMs);
      } catch (error) {
        console.error(
          `[ReportWorker:${slot}] Failed to claim/reconcile report jobs:`,
          summarizeError(error)
        );
        await sleepUntilPollOrShutdown(pollMs, shutdownController.signal);
        continue;
      }
      if (!job) {
        await sleepUntilPollOrShutdown(
          pollMs,
          shutdownController.signal
        );
        continue;
      }

      const startedAt = Date.now();
      console.log(`[ReportWorker:${slot}] Claimed ${job.type} ${String(job._id)}`);
      const jobId = String(job._id);
      const executionToken = String(job.executionToken || "").trim();
      if (!executionToken) {
        console.error(
          `[ReportWorker:${slot}] Claimed ${job.type} ${jobId} without an execution token; leaving its lease for safe reconciliation.`
        );
        await sleepUntilPollOrShutdown(pollMs, shutdownController.signal);
        continue;
      }
      const executionAbortController = new AbortController();
      let leaseLost = false;
      const markLeaseLost = () => {
        if (leaseLost) return;
        leaseLost = true;
        const error = new ReportJobOwnershipLostError(jobId);
        executionAbortController.abort(error);
        console.warn(
          `[ReportWorker:${slot}] Lost lease for ${job.type} ${jobId}; stale queue writes and finalization will be ignored`
        );
      };
      const executionContext: ReportJobExecutionContext = {
        executionToken,
        signal: executionAbortController.signal,
        assertOwned: async () => {
          if (executionAbortController.signal.aborted) {
            throw new ReportJobOwnershipLostError(jobId);
          }
          const owned = await ReportJob.exists({
            _id: jobId,
            status: "processing",
            lockedBy: workerId,
            attempts: job.attempts,
            executionToken,
          });
          if (!owned) {
            markLeaseLost();
            throw new ReportJobOwnershipLostError(jobId);
          }
        },
      };
      const heartbeat = setInterval(() => {
        void renewJobLease(
          jobId,
          workerId,
          job.attempts,
          executionToken,
          leaseMs
        )
          .then((renewed) => {
            if (!renewed) markLeaseLost();
          })
          .catch((error) => {
            console.error(
              `[ReportWorker:${slot}] Failed to renew lease for ${job.type} ${jobId}:`,
              error
            );
            // Renewal is an ownership check. On an ambiguous database failure,
            // stop side effects and let the durable retry reclaim the lease.
            markLeaseLost();
          });
      }, heartbeatMs);

      try {
        const handler = handlers[job.type];
        if (!handler) throw new Error(`No handler for report job type ${job.type}`);
        await activeReportJobExecution.run(
          { jobId, executionToken },
          () => reportActivityContext.run({ source: "unknown", verifiedLogoReceipts: new Set() }, () => handler(job, executionContext))
        );
        clearInterval(heartbeat);
        const completed = await completeJob(
          jobId,
          workerId,
          job.attempts,
          executionToken
        );
        if (completed) {
          // Source paths are shared by every retry attempt of this durable job.
          // Only the execution token that atomically completed the job may
          // remove them; a stale handler must leave them for the reclaimed
          // attempt. R2-backed descriptors have no local path and are ignored.
          await cleanupOwnedReportJobSourceFiles(job).catch(
            (cleanupError) => {
              console.error(
                `[ReportWorker:${slot}] Completed source-file cleanup failed:`,
                cleanupError
              );
            }
          );
          console.log(
            `[ReportWorker:${slot}] Completed ${job.type} ${jobId} in ${Date.now() - startedAt}ms`
          );
        } else {
          markLeaseLost();
          console.warn(
            `[ReportWorker:${slot}] Ignored stale completion for ${job.type} ${jobId}`
          );
        }
      } catch (error) {
        clearInterval(heartbeat);
        console.error(
          `[ReportWorker:${slot}] Failed ${job.type} ${jobId}:`,
          summarizeError(error)
        );
        try {
          const failed = await failJob(
            job,
            error,
            workerId,
            executionToken,
            leaseMs,
          );
          if (!failed) markLeaseLost();
        } catch (failureError) {
          console.error(
            `[ReportWorker:${slot}] Failure persistence failed for ${job.type} ${jobId}:`,
            summarizeError(failureError)
          );
        }
      } finally {
        clearInterval(heartbeat);
        if (!executionAbortController.signal.aborted) {
          executionAbortController.abort();
        }
      }
    }
  }

  try {
    await Promise.all(
      Array.from({ length: concurrency }, (_, index) => workerLoop(index + 1))
    );
  } finally {
    if (options.signal) {
      options.signal.removeEventListener("abort", stop);
    } else {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
    }
  }
}
