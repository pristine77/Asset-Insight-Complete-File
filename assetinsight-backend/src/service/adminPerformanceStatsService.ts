/**
 * Builds one analytics model across report collections that evolved with different
 * schemas. Normalization is intentionally kept here so dashboards compare workflow
 * milestones, retries, and outcomes with the same definitions and Regina business-day
 * boundaries rather than leaking collection-specific rules into controllers.
 */
import mongoose, { PipelineStage } from "mongoose";
import AssetReport from "../models/asset.model.js";
import LotListing from "../models/lotListing.model.js";
import PdfReport from "../models/pdfReport.model.js";
import RealEstateReport from "../models/realEstate.model.js";
import ReportJob from "../models/reportJob.model.js";
import ReportUploadSession from "../models/reportUploadSession.model.js";
import User from "../models/user.model.js";
import {
  ReportWorkflowStage,
  resolveReportGenerationState,
} from "../utils/reportFileState.js";

export const ADMIN_STATS_TIME_ZONE = "America/Regina";

const REGINA_OFFSET = "-06:00";
const DAY_MS = 24 * 60 * 60 * 1000;
const REPORT_TYPES = ["Asset", "LotListing", "RealEstate", "Salvage"] as const;

type AdminReportType = (typeof REPORT_TYPES)[number];
type OutcomeFilter = "all" | "ready" | "error";

export type AdminPerformanceFilters = {
  from: Date;
  to: Date;
  userId?: string;
  reportType?: AdminReportType;
  workflowStage?: ReportWorkflowStage;
  outcome?: OutcomeFilter;
};

type NormalizedReport = {
  id: string;
  userId: string;
  reportType: AdminReportType;
  title: string;
  contractNo: string;
  createdAt: Date;
  updatedAt: Date;
  status: string;
  releaseStatus: string;
  workflowStage: ReportWorkflowStage;
  workflowMessage: string;
  lotCount: number;
  imageCount: number;
  thumbnailUrl: string | null;
  previewSubmittedAt?: Date;
  approvalRequestedAt?: Date;
  approvalProcessedAt?: Date;
  releaseAssignedAt?: Date;
  releasedAt?: Date;
  queuedAt?: Date;
  processingCompletedAt?: Date;
  jobError?: string;
  filesReady: boolean;
};

type ReportTiming = {
  previewMinutes?: number;
  fileMinutes?: number;
  approvalMinutes?: number;
  releaseMinutes?: number;
  endToEndMinutes?: number;
  retries: number;
  attempts: number;
  timeline: Array<{ key: string; label: string; at: string }>;
};

type UserRef = {
  _id: unknown;
  email?: string;
  username?: string;
  companyName?: string;
  isBlocked?: boolean;
};

type EmployeeAccumulator = {
  userId: string;
  reports: number;
  lots: number;
  images: number;
  ready: number;
  failed: number;
  retryReports: number;
  retries: number;
  activeDates: Set<string>;
  activityTimes: Date[];
  previewTimes: number[];
  fileTimes: number[];
  endToEndTimes: number[];
  byType: Record<AdminReportType, number>;
  lastActivityAt?: Date;
};

const isDate = (value: unknown): value is Date =>
  value instanceof Date && Number.isFinite(value.getTime());

function asDate(value: unknown): Date | undefined {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(date.getTime()) ? date : undefined;
}

function safeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function safeNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function durationMinutes(start: unknown, end: unknown): number | undefined {
  const startDate = asDate(start);
  const endDate = asDate(end);
  if (!startDate || !endDate || endDate < startDate) return undefined;
  return Number(((endDate.getTime() - startDate.getTime()) / 60000).toFixed(2));
}

function percentile(values: number[], fraction: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil(sorted.length * fraction) - 1);
  return Number(sorted[index].toFixed(2));
}

function average(values: number[]): number | null {
  if (!values.length) return null;
  return Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2));
}

function datePartsInRegina(value: Date): { date: string; time: string } {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: ADMIN_STATS_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(value).map((part) => [part.type, part.value])
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
  };
}

export function reginaDateKey(value: Date | string): string {
  return datePartsInRegina(new Date(value)).date;
}

function parseReginaBoundary(value: unknown, fallback: Date, endOfDay = false): Date {
  const normalized = safeString(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    return new Date(`${normalized}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}${REGINA_OFFSET}`);
  }
  const parsed = normalized ? new Date(normalized) : fallback;
  return Number.isFinite(parsed.getTime()) ? parsed : fallback;
}

// Date-only filters represent business days, not the server's local timezone. Regina's
// fixed UTC-06 offset makes boundaries stable across hosts and daylight-saving changes.
export function parseAdminPerformanceFilters(query: Record<string, unknown>): AdminPerformanceFilters {
  const now = new Date();
  const defaultFrom = new Date(now.getTime() - 29 * DAY_MS);
  const from = parseReginaBoundary(query.from, defaultFrom);
  const to = parseReginaBoundary(query.to, now, true);
  if (from > to) throw new Error("From date must be before to date");

  const reportTypeValue = safeString(query.reportType) as AdminReportType;
  const stageValue = safeString(query.workflowStage) as ReportWorkflowStage;
  const outcomeValue = safeString(query.outcome) as OutcomeFilter;

  return {
    from,
    to,
    ...(mongoose.isValidObjectId(query.userId) ? { userId: String(query.userId) } : {}),
    ...(REPORT_TYPES.includes(reportTypeValue) ? { reportType: reportTypeValue } : {}),
    ...([
      "preparing_preview",
      "preview_ready",
      "generating_files",
      "awaiting_approval",
      "awaiting_release",
      "ready",
      "error",
    ].includes(stageValue)
      ? { workflowStage: stageValue }
      : {}),
    ...(["ready", "error"].includes(outcomeValue) ? { outcome: outcomeValue } : { outcome: "all" as const }),
  };
}

function arrayExpression(path: string): Record<string, unknown> {
  return { $cond: [{ $isArray: path }, path, []] };
}

function preferredLotsExpression(): Record<string, unknown> {
  const previewLots = arrayExpression("$preview_data.lots");
  const rootLots = arrayExpression("$lots");
  return { $cond: [{ $gt: [{ $size: previewLots }, 0] }, previewLots, rootLots] };
}

function imageCountExpression(): Record<string, unknown> {
  const root = { $size: arrayExpression("$imageUrls") };
  const rootExtra = { $size: arrayExpression("$extraImageUrls") };
  const preview = { $size: arrayExpression("$preview_data.image_urls") };
  const previewCamel = { $size: arrayExpression("$preview_data.imageUrls") };
  const previewExtra = { $size: arrayExpression("$preview_data.extra_image_urls") };
  return { $max: [{ $add: [root, rootExtra] }, { $add: [{ $max: [preview, previewCamel] }, previewExtra] }] };
}

function baseMatch(filters: AdminPerformanceFilters): Record<string, unknown> {
  const match: Record<string, unknown> = {
    createdAt: { $gte: filters.from, $lte: filters.to },
    // Draft preview derivatives are operational cache records, not employee output.
    is_draft_preview: { $ne: true },
  };
  if (filters.userId) match.user = new mongoose.Types.ObjectId(filters.userId);
  return match;
}

// Push common projection work into MongoDB so each collection returns only the fields
// needed for the normalized analytics contract. `$ifNull` aliases preserve old reports.
function assetLikePipeline(
  filters: AdminPerformanceFilters,
  reportType: "Asset" | "LotListing"
): PipelineStage[] {
  const lots = preferredLotsExpression();
  return [
    { $match: baseMatch(filters) },
    {
      $project: {
        user: 1,
        createdAt: 1,
        updatedAt: 1,
        status: 1,
        release_status: 1,
        preview_submitted_at: 1,
        approval_requested_at: 1,
        approval_processed_at: 1,
        release_assigned_at: 1,
        released_at: 1,
        queued_at: 1,
        processing_completed_at: 1,
        job_status: 1,
        job_error: 1,
        error_message: 1,
        generation_progress: 1,
        generation_target_status: 1,
        files_generating: 1,
        files_regenerating: 1,
        preview_files: 1,
        files: 1,
        contractNo: { $ifNull: ["$preview_data.contract_no", "$contract_no"] },
        title: {
          $ifNull: [
            "$preview_data.client_name",
            { $ifNull: ["$preview_data.prepared_for", { $ifNull: ["$client_name", "$prepared_for"] }] },
          ],
        },
        lotCount: { $size: lots },
        imageCount: imageCountExpression(),
        reportType: { $literal: reportType },
      },
    },
  ];
}

// Salvage stores one PDF row per generated artifact, unlike the document-per-report
// collections above; its aggregation groups siblings before all rows enter this model.
async function loadNormalizedReports(filters: AdminPerformanceFilters): Promise<NormalizedReport[]> {
  const requested = filters.reportType;
  const tasks: Array<Promise<any[]>> = [];

  if (!requested || requested === "Asset") {
    tasks.push(AssetReport.aggregate(assetLikePipeline(filters, "Asset")));
  } else tasks.push(Promise.resolve([]));

  if (!requested || requested === "LotListing") {
    tasks.push(LotListing.aggregate(assetLikePipeline(filters, "LotListing")));
  } else tasks.push(Promise.resolve([]));

  if (!requested || requested === "RealEstate") {
    tasks.push(
      RealEstateReport.aggregate([
        { $match: baseMatch(filters) },
        {
          $project: {
            user: 1,
            createdAt: 1,
            updatedAt: 1,
            status: 1,
            release_status: 1,
            preview_submitted_at: 1,
            approval_requested_at: 1,
            approval_processed_at: 1,
            release_assigned_at: 1,
            released_at: 1,
            job_status: 1,
            job_error: 1,
            files_generating: 1,
            files_regenerating: 1,
            preview_files: 1,
            contractNo: { $ifNull: ["$preview_data.contract_no", ""] },
            title: { $ifNull: ["$preview_data.property_details.address", "$property_details.address"] },
            lotCount: { $literal: 0 },
            imageCount: imageCountExpression(),
            reportType: { $literal: "RealEstate" },
          },
        },
      ])
    );
  } else tasks.push(Promise.resolve([]));

  if (!requested || requested === "Salvage") {
    tasks.push(
      (PdfReport as any).aggregate([
        { $match: { ...baseMatch(filters), reportType: "Salvage" } },
        { $sort: { createdAt: 1 } },
        {
          $group: {
            _id: { $ifNull: ["$report", "$_id"] },
            user: { $first: "$user" },
            createdAt: { $min: "$createdAt" },
            updatedAt: { $max: "$updatedAt" },
            approvalStatus: { $first: "$approvalStatus" },
            release_status: { $first: "$release_status" },
            reviewedAt: { $max: "$reviewedAt" },
            approval_assigned_at: { $min: "$approval_assigned_at" },
            release_assigned_at: { $min: "$release_assigned_at" },
            released_at: { $max: "$released_at" },
            contractNo: { $first: "$contract_no" },
            title: { $first: "$address" },
          },
        },
        {
          $project: {
            user: 1,
            createdAt: 1,
            updatedAt: 1,
            status: "$approvalStatus",
            release_status: 1,
            approval_requested_at: "$approval_assigned_at",
            approval_processed_at: "$reviewedAt",
            release_assigned_at: 1,
            released_at: 1,
            contractNo: 1,
            title: 1,
            lotCount: { $literal: 0 },
            imageCount: { $literal: 0 },
            reportType: { $literal: "Salvage" },
          },
        },
      ])
    );
  } else tasks.push(Promise.resolve([]));

  const [assets, lots, realEstate, salvage] = await Promise.all(tasks);
  const records = [...assets, ...lots, ...realEstate, ...salvage];

  return records.map((record: any) => {
    const reportType = record.reportType as AdminReportType;
    const status = safeString(record.status).toLowerCase();
    const releaseStatus = safeString(record.release_status).toLowerCase();
    let workflowStage: ReportWorkflowStage;
    let workflowMessage = "";
    let filesReady = false;

    if (reportType === "Asset" || reportType === "LotListing") {
      const state = resolveReportGenerationState(record, record.files, record.preview_files);
      workflowStage = state.workflow_stage;
      workflowMessage = state.workflow_message;
      filesReady = state.files_ready;
    } else if (safeString(record.job_error) || status === "error" || status === "rejected") {
      workflowStage = "error";
      workflowMessage = safeString(record.job_error) || "Report processing failed";
    } else if (record.files_generating || record.files_regenerating || ["queued", "processing"].includes(safeString(record.job_status))) {
      workflowStage = record.preview_submitted_at ? "generating_files" : "preparing_preview";
      workflowMessage = record.preview_submitted_at ? "Generating files" : "Preparing preview";
    } else if (status === "preview" || status === "declined") {
      workflowStage = "preview_ready";
      workflowMessage = "Preview ready";
    } else if (status === "pending_approval" || status === "pending") {
      workflowStage = "awaiting_approval";
      workflowMessage = "Awaiting approval";
    } else if (releaseStatus === "pending_release") {
      workflowStage = "awaiting_release";
      workflowMessage = "Awaiting release";
    } else {
      workflowStage = "ready";
      workflowMessage = "Ready";
      filesReady = true;
    }

    return {
      id: String(record._id),
      userId: String(record.user || "unknown"),
      reportType,
      title: safeString(record.title) || `${reportType} Report`,
      contractNo: safeString(record.contractNo),
      createdAt: asDate(record.createdAt) || new Date(0),
      updatedAt: asDate(record.updatedAt) || asDate(record.createdAt) || new Date(0),
      status,
      releaseStatus,
      workflowStage,
      workflowMessage,
      lotCount: Math.max(0, Math.round(safeNumber(record.lotCount))),
      imageCount: Math.max(0, Math.round(safeNumber(record.imageCount))),
      thumbnailUrl: null,
      previewSubmittedAt: asDate(record.preview_submitted_at),
      approvalRequestedAt: asDate(record.approval_requested_at),
      approvalProcessedAt: asDate(record.approval_processed_at),
      releaseAssignedAt: asDate(record.release_assigned_at),
      releasedAt: asDate(record.released_at),
      queuedAt: asDate(record.queued_at),
      processingCompletedAt: asDate(record.processing_completed_at),
      jobError: safeString(record.job_error || record.error_message),
      filesReady,
    };
  });
}

// First completion measures user-visible time to the initial usable artifact. Attempts
// are counted separately below, so later successful retries do not inflate that latency.
function chooseFirstCompletedJob(jobs: any[], suffix: "preview" | "files"): any | undefined {
  return jobs
    .filter((job) => String(job.type || "").endsWith(suffix === "preview" ? "-preview" : "-files"))
    .sort((left, right) => new Date(left.completedAt || left.createdAt).getTime() - new Date(right.completedAt || right.createdAt).getTime())
    .find((job) => job.completedAt) || jobs.find((job) => String(job.type || "").endsWith(suffix === "preview" ? "-preview" : "-files"));
}

function buildTiming(report: NormalizedReport, jobs: any[], session?: any): ReportTiming {
  const previewJob = chooseFirstCompletedJob(jobs, "preview");
  const fileJob = chooseFirstCompletedJob(jobs, "files");
  const previewStart = asDate(session?.uploadStartedAt) || asDate(previewJob?.queuedAt) || report.queuedAt || report.createdAt;
  const previewEnd = asDate(previewJob?.completedAt) || report.processingCompletedAt;
  const fileStart = report.previewSubmittedAt || asDate(fileJob?.queuedAt);
  const fileEnd = asDate(fileJob?.completedAt) || (report.filesReady ? report.processingCompletedAt : undefined);
  const readyAt = report.releasedAt || (report.workflowStage === "ready" ? fileEnd : undefined);
  const attempts = jobs.reduce((sum, job) => sum + Math.max(0, safeNumber(job.attempts)), 0);
  const retries = jobs.reduce((sum, job) => sum + Math.max(0, safeNumber(job.attempts) - 1), 0);

  const timelineEntries: Array<[string, string, Date | undefined]> = [
    ["created", "Report created", report.createdAt],
    ["upload_started", "Upload started", asDate(session?.uploadStartedAt)],
    ["preview_ready", "Preview ready", previewEnd],
    ["preview_submitted", "Preview submitted", report.previewSubmittedAt],
    ["files_ready", "Files generated", fileEnd],
    ["approval_requested", "Approval requested", report.approvalRequestedAt],
    ["approved", "Approval completed", report.approvalProcessedAt],
    ["release_assigned", "Release assigned", report.releaseAssignedAt],
    ["released", "Released", report.releasedAt],
  ];

  return {
    previewMinutes: durationMinutes(previewStart, previewEnd),
    fileMinutes: durationMinutes(fileStart, fileEnd),
    approvalMinutes: durationMinutes(report.approvalRequestedAt, report.approvalProcessedAt),
    releaseMinutes: durationMinutes(report.releaseAssignedAt, report.releasedAt),
    endToEndMinutes: durationMinutes(asDate(session?.uploadStartedAt) || report.createdAt, readyAt),
    retries,
    attempts,
    timeline: timelineEntries
      .filter((entry): entry is [string, string, Date] => isDate(entry[2]))
      .sort((left, right) => left[2].getTime() - right[2].getTime())
      .map(([key, label, at]) => ({ key, label, at: at.toISOString() })),
  };
}

function emptyEmployee(userId: string): EmployeeAccumulator {
  return {
    userId,
    reports: 0,
    lots: 0,
    images: 0,
    ready: 0,
    failed: 0,
    retryReports: 0,
    retries: 0,
    activeDates: new Set(),
    activityTimes: [],
    previewTimes: [],
    fileTimes: [],
    endToEndTimes: [],
    byType: { Asset: 0, LotListing: 0, RealEstate: 0, Salvage: 0 },
  };
}

function userLabel(user: UserRef | undefined, fallback: string): string {
  return safeString(user?.username) || safeString(user?.companyName) || safeString(user?.email) || fallback;
}

function eventTimes(report: NormalizedReport, timing: ReportTiming): Date[] {
  const timelineDates = timing.timeline.map((entry) => new Date(entry.at)).filter(isDate);
  return [report.createdAt, report.updatedAt, ...timelineDates].filter(isDate);
}

function serializeEmployee(employee: EmployeeAccumulator, user?: UserRef) {
  const firstActivity = employee.activityTimes.length
    ? new Date(Math.min(...employee.activityTimes.map((value) => value.getTime())))
    : undefined;
  const lastActivity = employee.activityTimes.length
    ? new Date(Math.max(...employee.activityTimes.map((value) => value.getTime())))
    : undefined;
  return {
    userId: employee.userId,
    name: userLabel(user, employee.userId),
    email: safeString(user?.email),
    accountState: user ? (user.isBlocked ? "blocked" : "active") : "historical",
    activeDays: employee.activeDates.size,
    firstActivityAt: firstActivity?.toISOString() || null,
    lastActivityAt: lastActivity?.toISOString() || null,
    reports: employee.reports,
    lots: employee.lots,
    images: employee.images,
    averageLotsPerReport: employee.reports ? Number((employee.lots / employee.reports).toFixed(2)) : 0,
    medianPreviewMinutes: percentile(employee.previewTimes, 0.5),
    p90PreviewMinutes: percentile(employee.previewTimes, 0.9),
    medianFileMinutes: percentile(employee.fileTimes, 0.5),
    p90FileMinutes: percentile(employee.fileTimes, 0.9),
    p90EndToEndMinutes: percentile(employee.endToEndTimes, 0.9),
    readyReports: employee.ready,
    retryReports: employee.retryReports,
    failedReports: employee.failed,
    readyRate: employee.reports ? Number(((employee.ready / employee.reports) * 100).toFixed(1)) : 0,
    retryRate: employee.reports ? Number(((employee.retryReports / employee.reports) * 100).toFixed(1)) : 0,
    failureRate: employee.reports ? Number(((employee.failed / employee.reports) * 100).toFixed(1)) : 0,
    retries: employee.retries,
    byType: employee.byType,
  };
}

// Reports, jobs, sessions, and users are independent reads. Joining them in memory keeps
// collection-specific indexes usable and avoids a large cross-collection aggregation.
async function loadAnalyticsContext(filters: AdminPerformanceFilters) {
  let reports = await loadNormalizedReports(filters);
  const reportIds = reports.map((report) => report.id);
  const userIds = [...new Set(reports.map((report) => report.userId).filter((value) => mongoose.isValidObjectId(value)))];

  const [jobs, sessions, users] = await Promise.all([
    reportIds.length
      ? ReportJob.find({ reportId: { $in: reportIds } })
          .select("reportId type status attempts queuedAt startedAt completedAt failedAt lastError createdAt")
          .sort({ createdAt: 1 })
          .lean()
      : [],
    reportIds.length
      ? ReportUploadSession.find({ reportId: { $in: reportIds } })
          .select("reportId uploadStartedAt uploadCompletedAt expectedImageCount status createdAt")
          .sort({ createdAt: 1 })
          .lean()
      : [],
    userIds.length
      ? User.find({ _id: { $in: userIds } })
          .select("email username companyName isBlocked")
          .lean()
      : [],
  ]);

  const jobsByReport = new Map<string, any[]>();
  for (const job of jobs as any[]) {
    const key = String(job.reportId || "");
    if (!key) continue;
    const current = jobsByReport.get(key) || [];
    current.push(job);
    jobsByReport.set(key, current);
  }
  const sessionByReport = new Map<string, any>();
  for (const session of sessions as any[]) {
    const key = String(session.reportId || "");
    if (key && !sessionByReport.has(key)) sessionByReport.set(key, session);
  }
  const usersById = new Map((users as any[]).map((user) => [String(user._id), user as UserRef]));
  const timingByReport = new Map<string, ReportTiming>();
  for (const report of reports) {
    const session = sessionByReport.get(report.id);
    if (session?.expectedImageCount && session.expectedImageCount > report.imageCount) {
      report.imageCount = session.expectedImageCount;
    }
    timingByReport.set(report.id, buildTiming(report, jobsByReport.get(report.id) || [], session));
  }

  // Workflow/outcome are derived from normalized file state, so these filters must run
  // after collection-specific records have passed through the shared resolver.
  if (filters.workflowStage) reports = reports.filter((report) => report.workflowStage === filters.workflowStage);
  if (filters.outcome === "ready") reports = reports.filter((report) => report.workflowStage === "ready");
  if (filters.outcome === "error") reports = reports.filter((report) => report.workflowStage === "error");

  return { reports, timingByReport, usersById, jobsByReport };
}

export async function getAdminPerformanceStats(filters: AdminPerformanceFilters) {
  const { reports, timingByReport, usersById } = await loadAnalyticsContext(filters);
  const employeeMap = new Map<string, EmployeeAccumulator>();
  const dailyMap = new Map<string, {
    reports: number;
    lots: number;
    images: number;
    previewTimes: number[];
    fileTimes: number[];
    creators: Set<string>;
  }>();
  const workflow = new Map<ReportWorkflowStage, number>();
  const previewTimes: number[] = [];
  const fileTimes: number[] = [];
  const endToEndTimes: number[] = [];
  let ready = 0;
  let failed = 0;
  let retries = 0;

  for (const report of reports) {
    const timing = timingByReport.get(report.id) || buildTiming(report, [], undefined);
    const employee = employeeMap.get(report.userId) || emptyEmployee(report.userId);
    employee.reports += 1;
    employee.lots += report.lotCount;
    employee.images += report.imageCount;
    employee.byType[report.reportType] += 1;
    employee.ready += report.workflowStage === "ready" ? 1 : 0;
    employee.failed += report.workflowStage === "error" ? 1 : 0;
    employee.retryReports += timing.retries > 0 ? 1 : 0;
    employee.retries += timing.retries;
    if (typeof timing.previewMinutes === "number") employee.previewTimes.push(timing.previewMinutes);
    if (typeof timing.fileMinutes === "number") employee.fileTimes.push(timing.fileMinutes);
    if (typeof timing.endToEndMinutes === "number") employee.endToEndTimes.push(timing.endToEndMinutes);
    for (const activity of eventTimes(report, timing)) {
      employee.activeDates.add(reginaDateKey(activity));
      employee.activityTimes.push(activity);
      if (!employee.lastActivityAt || activity > employee.lastActivityAt) employee.lastActivityAt = activity;
    }
    employeeMap.set(report.userId, employee);

    const day = reginaDateKey(report.createdAt);
    const daily = dailyMap.get(day) || {
      reports: 0,
      lots: 0,
      images: 0,
      previewTimes: [],
      fileTimes: [],
      creators: new Set<string>(),
    };
    daily.reports += 1;
    daily.lots += report.lotCount;
    daily.images += report.imageCount;
    daily.creators.add(report.userId);
    if (typeof timing.previewMinutes === "number") daily.previewTimes.push(timing.previewMinutes);
    if (typeof timing.fileMinutes === "number") daily.fileTimes.push(timing.fileMinutes);
    dailyMap.set(day, daily);

    workflow.set(report.workflowStage, (workflow.get(report.workflowStage) || 0) + 1);
    if (typeof timing.previewMinutes === "number") previewTimes.push(timing.previewMinutes);
    if (typeof timing.fileMinutes === "number") fileTimes.push(timing.fileMinutes);
    if (typeof timing.endToEndMinutes === "number") endToEndTimes.push(timing.endToEndMinutes);
    ready += report.workflowStage === "ready" ? 1 : 0;
    failed += report.workflowStage === "error" ? 1 : 0;
    retries += timing.retries > 0 ? 1 : 0;
  }

  const employees = [...employeeMap.values()]
    .map((employee) => serializeEmployee(employee, usersById.get(employee.userId)))
    .sort((left, right) => right.reports - left.reports || right.lots - left.lots);
  const daily = [...dailyMap.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, value]) => ({
      date,
      reports: value.reports,
      lots: value.lots,
      images: value.images,
      activeCreators: value.creators.size,
      medianPreviewMinutes: percentile(value.previewTimes, 0.5),
      medianFileMinutes: percentile(value.fileTimes, 0.5),
    }));

  const byType = REPORT_TYPES.map((reportType) => ({
    type: reportType,
    reports: reports.filter((report) => report.reportType === reportType).length,
    lots: reports.filter((report) => report.reportType === reportType).reduce((sum, report) => sum + report.lotCount, 0),
  }));
  const workflowOrder: ReportWorkflowStage[] = [
    "preparing_preview",
    "preview_ready",
    "generating_files",
    "awaiting_approval",
    "awaiting_release",
    "ready",
    "error",
  ];

  return {
    range: {
      from: filters.from.toISOString(),
      to: filters.to.toISOString(),
      timeZone: ADMIN_STATS_TIME_ZONE,
    },
    summary: {
      totalReports: reports.length,
      totalLots: reports.reduce((sum, report) => sum + report.lotCount, 0),
      totalImages: reports.reduce((sum, report) => sum + report.imageCount, 0),
      activeCreators: employeeMap.size,
      readyReports: ready,
      failedReports: failed,
      retryReports: retries,
      medianPreviewMinutes: percentile(previewTimes, 0.5),
      medianFileMinutes: percentile(fileTimes, 0.5),
      p90EndToEndMinutes: percentile(endToEndTimes, 0.9),
    },
    coverage: {
      previewTiming: { covered: previewTimes.length, total: reports.length },
      fileTiming: { covered: fileTimes.length, total: reports.length },
      endToEndTiming: { covered: endToEndTimes.length, total: reports.length },
    },
    daily,
    byType,
    workflow: workflowOrder.map((stage) => ({ stage, count: workflow.get(stage) || 0 })),
    outcomes: {
      ready,
      retry: retries,
      failed,
      readyRate: reports.length ? Number(((ready / reports.length) * 100).toFixed(1)) : 0,
      retryRate: reports.length ? Number(((retries / reports.length) * 100).toFixed(1)) : 0,
      failureRate: reports.length ? Number(((failed / reports.length) * 100).toFixed(1)) : 0,
    },
    backlog: reports
      .filter((report) => !["ready", "error"].includes(report.workflowStage))
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())
      .slice(0, 50)
      .map((report) => ({
        id: report.id,
        reportType: report.reportType,
        title: report.title,
        contractNo: report.contractNo,
        creator: userLabel(usersById.get(report.userId), report.userId),
        lotCount: report.lotCount,
        workflowStage: report.workflowStage,
        workflowMessage: report.workflowMessage,
        elapsedMinutes: durationMinutes(report.updatedAt, new Date()) || durationMinutes(report.createdAt, new Date()) || 0,
        createdAt: report.createdAt.toISOString(),
      })),
    employees,
    filterOptions: {
      creators: employees.map((employee) => ({ id: employee.userId, label: employee.name, email: employee.email })),
      reportTypes: REPORT_TYPES,
      workflowStages: workflowOrder,
    },
  };
}

export async function getAdminPerformanceUserDetail(
  userId: string,
  filters: AdminPerformanceFilters
) {
  if (!mongoose.isValidObjectId(userId)) throw new Error("Invalid employee id");
  const scopedFilters = { ...filters, userId };
  const { reports, timingByReport, usersById, jobsByReport } = await loadAnalyticsContext(scopedFilters);
  const employee = emptyEmployee(userId);
  const daily = new Map<string, { first: Date; last: Date; reports: number; lots: number; images: number }>();

  const reportRows = reports.map((report) => {
    const timing = timingByReport.get(report.id) || buildTiming(report, [], undefined);
    employee.reports += 1;
    employee.lots += report.lotCount;
    employee.images += report.imageCount;
    employee.byType[report.reportType] += 1;
    employee.ready += report.workflowStage === "ready" ? 1 : 0;
    employee.failed += report.workflowStage === "error" ? 1 : 0;
    employee.retryReports += timing.retries > 0 ? 1 : 0;
    employee.retries += timing.retries;
    if (typeof timing.previewMinutes === "number") employee.previewTimes.push(timing.previewMinutes);
    if (typeof timing.fileMinutes === "number") employee.fileTimes.push(timing.fileMinutes);
    if (typeof timing.endToEndMinutes === "number") employee.endToEndTimes.push(timing.endToEndMinutes);

    for (const activity of eventTimes(report, timing)) {
      const key = reginaDateKey(activity);
      employee.activeDates.add(key);
      employee.activityTimes.push(activity);
      const current = daily.get(key);
      daily.set(key, {
        first: !current || activity < current.first ? activity : current.first,
        last: !current || activity > current.last ? activity : current.last,
        reports: current?.reports || 0,
        lots: current?.lots || 0,
        images: current?.images || 0,
      });
    }
    const createdDay = reginaDateKey(report.createdAt);
    const createdDaily = daily.get(createdDay) || {
      first: report.createdAt,
      last: report.createdAt,
      reports: 0,
      lots: 0,
      images: 0,
    };
    createdDaily.reports += 1;
    createdDaily.lots += report.lotCount;
    createdDaily.images += report.imageCount;
    daily.set(createdDay, createdDaily);

    return {
      id: report.id,
      reportType: report.reportType,
      title: report.title,
      contractNo: report.contractNo,
      workflowStage: report.workflowStage,
      workflowMessage: report.workflowMessage,
      lotCount: report.lotCount,
      imageCount: report.imageCount,
      createdAt: report.createdAt.toISOString(),
      updatedAt: report.updatedAt.toISOString(),
      previewMinutes: timing.previewMinutes ?? null,
      fileMinutes: timing.fileMinutes ?? null,
      approvalMinutes: timing.approvalMinutes ?? null,
      releaseMinutes: timing.releaseMinutes ?? null,
      endToEndMinutes: timing.endToEndMinutes ?? null,
      retries: timing.retries,
      attempts: timing.attempts,
      error: report.jobError || (jobsByReport.get(report.id) || []).find((job) => job.status === "failed")?.lastError || null,
      timeline: timing.timeline,
    };
  });

  const serializedEmployee = serializeEmployee(employee, usersById.get(userId));
  return {
    range: {
      from: filters.from.toISOString(),
      to: filters.to.toISOString(),
      timeZone: ADMIN_STATS_TIME_ZONE,
    },
    employee: serializedEmployee,
    coverage: {
      previewTiming: { covered: employee.previewTimes.length, total: reports.length },
      fileTiming: { covered: employee.fileTimes.length, total: reports.length },
      endToEndTiming: { covered: employee.endToEndTimes.length, total: reports.length },
    },
    daily: [...daily.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([date, value]) => ({
        date,
        firstActivity: datePartsInRegina(value.first).time,
        lastActivity: datePartsInRegina(value.last).time,
        activitySpanMinutes: durationMinutes(value.first, value.last) || 0,
        reports: value.reports,
        lots: value.lots,
        images: value.images,
      })),
    byType: REPORT_TYPES.map((type) => ({ type, count: employee.byType[type] })),
    reports: reportRows.sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
    failures: reportRows.filter((report) => report.workflowStage === "error"),
    outliers: [...reportRows]
      .filter((report) => typeof report.endToEndMinutes === "number")
      .sort((left, right) => Number(right.endToEndMinutes) - Number(left.endToEndMinutes))
      .slice(0, 10),
  };
}

function firstLotThumbnail(report: any): string | null {
  const lots = Array.isArray(report?.preview_data?.lots) && report.preview_data.lots.length
    ? report.preview_data.lots
    : Array.isArray(report?.lots)
      ? report.lots
      : [];
  const globalUrls = Array.isArray(report?.imageUrls) ? report.imageUrls : [];
  const firstLot = lots[0] || {};
  const direct = [firstLot.image_url, ...(Array.isArray(firstLot.image_urls) ? firstLot.image_urls : [])]
    .find((value) => safeString(value));
  if (direct) return safeString(direct);
  const index = Array.isArray(firstLot.image_indexes) ? Number(firstLot.image_indexes[0]) : Number.NaN;
  return Number.isInteger(index) && safeString(globalUrls[index]) ? safeString(globalUrls[index]) : safeString(globalUrls[0]) || null;
}

function queueStageStart(report: any, stage: ReportWorkflowStage): Date {
  const candidates: Record<ReportWorkflowStage, unknown[]> = {
    preparing_preview: [report.queued_at, report.processing_started_at, report.createdAt],
    preview_ready: [report.processing_completed_at, report.updatedAt, report.createdAt],
    generating_files: [report.preview_submitted_at, report.queued_at, report.updatedAt],
    awaiting_approval: [report.approval_requested_at, report.updatedAt],
    awaiting_release: [report.release_assigned_at, report.updatedAt],
    ready: [report.released_at, report.processing_completed_at, report.updatedAt],
    error: [report.updatedAt, report.createdAt],
  };
  return candidates[stage].map(asDate).find(isDate) || new Date();
}

// The queue is intentionally wider than "unfinished": today's completions remain visible
// long enough for supervisors to understand throughput and recent transitions.
export async function getAdminWorkflowQueueSnapshot() {
  const now = new Date();
  const todayKey = reginaDateKey(now);
  const todayStart = new Date(`${todayKey}T00:00:00.000${REGINA_OFFSET}`);
  const todayEnd = new Date(`${todayKey}T23:59:59.999${REGINA_OFFSET}`);
  const activeFilter = {
    adminArchivedAt: null,
    is_draft_preview: { $ne: true },
    $or: [
      { status: { $in: ["processing", "preview", "pending_approval", "error"] } },
      { release_status: "pending_release" },
      { job_status: { $in: ["queued", "processing", "error"] } },
      { files_generating: true },
      { files_regenerating: true },
      { released_at: { $gte: todayStart, $lte: todayEnd } },
    ],
  };

  const [assets, lots, realEstate, salvageRows] = await Promise.all([
    AssetReport.find(activeFilter)
      .select("user contract_no status release_status createdAt updatedAt queued_at processing_started_at processing_completed_at preview_submitted_at approval_requested_at release_assigned_at released_at job_status job_error generation_progress generation_target_status files_generating files_regenerating files preview_files lots preview_data imageUrls")
      .populate("user", "email username companyName isBlocked")
      .lean(),
    LotListing.find(activeFilter)
      .select("user contract_no status release_status createdAt updatedAt queued_at processing_started_at processing_completed_at preview_submitted_at approval_requested_at release_assigned_at released_at job_status job_error generation_progress generation_target_status files_generating files_regenerating files preview_files lots preview_data imageUrls")
      .populate("user", "email username companyName isBlocked")
      .lean(),
    RealEstateReport.find(activeFilter)
      .select("user status release_status createdAt updatedAt preview_submitted_at approval_requested_at release_assigned_at released_at job_status job_error files_generating files_regenerating preview_files preview_data property_details imageUrls")
      .populate("user", "email username companyName isBlocked")
      .lean(),
    PdfReport.find({
      reportType: "Salvage",
      adminArchivedAt: null,
      $or: [
        { approvalStatus: "pending" },
        { release_status: "pending_release" },
        { released_at: { $gte: todayStart, $lte: todayEnd } },
      ],
    })
      .select("user report approvalStatus release_status createdAt updatedAt approval_assigned_at release_assigned_at released_at contract_no address")
      .populate("user", "email username companyName isBlocked")
      .lean(),
  ]);

  const queueRecords: any[] = [];
  for (const [reportType, rows] of [["Asset", assets], ["LotListing", lots]] as const) {
    for (const report of rows as any[]) {
      const state = resolveReportGenerationState(report, report.files, report.preview_files);
      queueRecords.push({ report, reportType, stage: state.workflow_stage, message: state.workflow_message, error: state.job_error || "" });
    }
  }
  for (const report of realEstate as any[]) {
    const status = safeString(report.status);
    const stage: ReportWorkflowStage = report.job_error || status === "error"
      ? "error"
      : report.files_generating || report.files_regenerating || ["queued", "processing"].includes(safeString(report.job_status))
        ? report.preview_submitted_at ? "generating_files" : "preparing_preview"
        : status === "preview" || status === "declined"
          ? "preview_ready"
          : status === "pending_approval"
            ? "awaiting_approval"
            : report.release_status === "pending_release"
              ? "awaiting_release"
              : "ready";
    queueRecords.push({ report, reportType: "RealEstate", stage, message: stage.replace(/_/g, " "), error: report.job_error || "" });
  }

  const groupedSalvage = new Map<string, any>();
  for (const row of salvageRows as any[]) {
    const key = String(row.report || row._id);
    if (!groupedSalvage.has(key)) groupedSalvage.set(key, row);
  }
  for (const report of groupedSalvage.values()) {
    const stage: ReportWorkflowStage = report.approvalStatus === "pending"
      ? "awaiting_approval"
      : report.release_status === "pending_release"
        ? "awaiting_release"
        : "ready";
    queueRecords.push({ report, reportType: "Salvage", stage, message: stage.replace(/_/g, " "), error: "" });
  }

  const countStages: ReportWorkflowStage[] = [
    "preparing_preview",
    "preview_ready",
    "generating_files",
    "awaiting_approval",
    "awaiting_release",
  ];
  const counts = Object.fromEntries(countStages.map((stage) => [stage, 0])) as Record<string, number>;
  let releasedToday = 0;
  for (const entry of queueRecords) {
    if (entry.stage === "ready" && reginaDateKey(entry.report.released_at || entry.report.updatedAt) === todayKey) releasedToday += 1;
    if (entry.stage in counts) counts[entry.stage] += 1;
  }

  const items = queueRecords
    .filter((entry) => entry.stage !== "ready" || reginaDateKey(entry.report.released_at || entry.report.updatedAt) === todayKey)
    .sort((left, right) => new Date(right.report.updatedAt || right.report.createdAt).getTime() - new Date(left.report.updatedAt || left.report.createdAt).getTime())
    .slice(0, 60)
    .map((entry) => {
      const report = entry.report;
      const lotsValue = Array.isArray(report.preview_data?.lots) && report.preview_data.lots.length ? report.preview_data.lots : report.lots || [];
      const owner = report.user && typeof report.user === "object" ? report.user : null;
      return {
        id: String(report.report || report._id),
        reportType: entry.reportType,
        title: safeString(lotsValue?.[0]?.title || report.preview_data?.client_name || report.preview_data?.property_details?.address || report.property_details?.address || report.address) || `${entry.reportType} Report`,
        contractNo: safeString(report.preview_data?.contract_no || report.contract_no),
        creator: userLabel(owner, String(report.user || "unknown")),
        creatorEmail: safeString(owner?.email),
        lotCount: Array.isArray(lotsValue) ? lotsValue.length : 0,
        thumbnailUrl: firstLotThumbnail(report),
        workflowStage: entry.stage,
        workflowMessage: entry.message,
        elapsedMinutes: durationMinutes(queueStageStart(report, entry.stage), now) || 0,
        error: entry.error || null,
        createdAt: asDate(report.createdAt)?.toISOString(),
        updatedAt: asDate(report.updatedAt)?.toISOString(),
      };
    });

  return {
    preparingPreview: counts.preparing_preview,
    previewReady: counts.preview_ready,
    generatingFiles: counts.generating_files,
    awaitingApproval: counts.awaiting_approval,
    awaitingRelease: counts.awaiting_release,
    releasedToday,
    items,
  };
}
