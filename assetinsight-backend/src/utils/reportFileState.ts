import { hasSavedReportPreview } from "./reportPreviewAvailability.js";

const GENERATED_FILE_KEYS = [
  "pdf",
  "spec_pdf",
  "cr_docx",
  "docx",
  "excel",
  "xlsx",
  "images",
  "images_zip",
  "zip",
];

export type ReportGenerationState = "queued" | "processing" | "ready" | "error";
export type ReportArtifactProfile = "asset" | "realEstate" | "lotListing" | "salvage";

export type ReportWorkflowStage =
  | "preparing_preview"
  | "preview_ready"
  | "generating_files"
  | "awaiting_approval"
  | "awaiting_release"
  | "ready"
  | "error";

export type ReportStatePayload = {
  generation_state: ReportGenerationState;
  workflow_stage: ReportWorkflowStage;
  workflow_message: string;
  workflow_progress_percent: number;
  files_ready: boolean;
  preview_available?: boolean;
  job_status?: string;
  job_error?: string;
};

export function hasGeneratedReportFiles(...sources: any[]): boolean {
  return sources.some((source) => {
    if (!source || typeof source !== "object") return false;
    return GENERATED_FILE_KEYS.some((key) => {
      const value = source[key];
      return typeof value === "string" && value.trim().length > 0;
    });
  });
}

function hasArtifact(sources: any[], keys: string[]): boolean {
  return sources.some((source) => {
    if (!source || typeof source !== "object") return false;
    return keys.some((key) => {
      const value = source[key];
      return typeof value === "string" && value.trim().length > 0;
    });
  });
}

/**
 * CR artifacts are optional companions. They must not make a report look
 * complete when its primary downloadable files are missing.
 */
export function hasRequiredReportFiles(
  profile: ReportArtifactProfile,
  ...sources: any[]
): boolean {
  const hasSpreadsheet = hasArtifact(sources, ["excel", "xlsx"]);
  const hasImages = hasArtifact(sources, ["images", "images_zip", "zip"]);
  if (profile === "salvage") return hasArtifact(sources, ["pdf"]) && hasArtifact(sources, ["docx"]) && hasSpreadsheet && hasImages;
  if (profile === "lotListing") return hasSpreadsheet && hasImages;
  return hasArtifact(sources, ["docx"]) && hasSpreadsheet && hasImages;
}

function clampPercent(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(100, Math.round(parsed)));
}

function isSubmittedReport(report: any): boolean {
  const status = String(report?.status || "").trim().toLowerCase();
  const target = String(report?.generation_target_status || "").trim().toLowerCase();
  return Boolean(
    report?.preview_submitted_at ||
      report?.approval_requested_at ||
      ["pending_approval", "approved"].includes(status) ||
      ["pending_approval", "approved"].includes(target)
  );
}

function workflowForReport(
  report: any,
  generationState: ReportGenerationState,
  filesReady: boolean,
  jobError: string
): Pick<ReportStatePayload, "workflow_stage" | "workflow_message" | "workflow_progress_percent"> {
  const status = String(report?.status || "").trim().toLowerCase();
  const releaseStatus = String(report?.release_status || "").trim().toLowerCase();
  const submitted = isSubmittedReport(report);
  const progress = report?.generation_progress || {};
  const storedMessage = String(progress?.message || "").trim();
  const storedPercent = progress?.progressPercent;

  if (generationState === "error") {
    return {
      workflow_stage: "error",
      workflow_message: jobError || storedMessage || "Report processing failed. Please retry.",
      workflow_progress_percent: clampPercent(storedPercent, 100),
    };
  }

  if (generationState === "queued" || generationState === "processing") {
    const generatingFiles = submitted || String(progress?.stage || "") === "generating_files";
    return {
      workflow_stage: generatingFiles ? "generating_files" : "preparing_preview",
      workflow_message:
        storedMessage ||
        (generatingFiles
          ? "Generating the latest report files"
          : "Analyzing images and preparing your preview"),
      workflow_progress_percent: clampPercent(storedPercent, generationState === "queued" ? 3 : 25),
    };
  }

  if (!submitted && ["preview", "declined"].includes(status)) {
    return {
      workflow_stage: "preview_ready",
      workflow_message:
        status === "declined"
          ? "Changes are required before this preview can be submitted"
          : "Preview ready for review",
      workflow_progress_percent: 100,
    };
  }

  if (status === "pending_approval") {
    return {
      workflow_stage: filesReady ? "awaiting_approval" : "generating_files",
      workflow_message: filesReady ? "Files ready; awaiting approval" : "Generating the latest report files",
      workflow_progress_percent: filesReady ? 100 : clampPercent(storedPercent, 90),
    };
  }

  if (status === "approved" && releaseStatus === "pending_release") {
    return {
      workflow_stage: filesReady ? "awaiting_release" : "generating_files",
      workflow_message: filesReady ? "Approved; awaiting release" : "Generating the latest report files",
      workflow_progress_percent: filesReady ? 100 : clampPercent(storedPercent, 90),
    };
  }

  if (status === "approved" && filesReady) {
    return {
      workflow_stage: "ready",
      workflow_message: "Ready to download",
      workflow_progress_percent: 100,
    };
  }

  if (!submitted && status === "processing") {
    return {
      workflow_stage: "preparing_preview",
      workflow_message: storedMessage || "Analyzing images and preparing your preview",
      workflow_progress_percent: clampPercent(storedPercent, 25),
    };
  }

  return {
    workflow_stage: submitted ? "error" : "preview_ready",
    workflow_message: submitted
      ? jobError || "Report processing stopped before files were completed. Please retry."
      : "Preview ready for review",
    workflow_progress_percent: 100,
  };
}

/**
 * Resolve both legacy generation state and the user-facing workflow in one place.
 * Current queue/error state takes precedence over old artifacts during
 * regeneration. Otherwise existing artifact URLs are authoritative over stale
 * boolean flags.
 */
function resolveReportGenerationStateWithReadiness(
  report: any,
  filesReady: boolean
): ReportStatePayload {
  const artifactRepairRequired = report?.artifact_repair_required === true;
  if (artifactRepairRequired) filesReady = false;
  const jobStatus = String(report?.job_status || "").trim().toLowerCase();
  const reportStatus = String(report?.status || "").trim().toLowerCase();
  const jobError = String(report?.job_error || report?.error_message || "").trim();

  let generationState: ReportGenerationState;
  let resolvedJobStatus = jobStatus;
  let resolvedError = jobError;

  // Publication sets its repair barrier before copying the complete file set.
  // While an owned run (or its durable retry) is active this is a download lock,
  // not a terminal failure. Keep polling the active run; never expose old files.
  if (jobStatus === "queued") {
    generationState = "queued";
  } else if (jobStatus === "processing") {
    generationState = "processing";
  } else if (artifactRepairRequired) {
    generationState = "error";
    resolvedJobStatus = "error";
    resolvedError =
      jobError ||
      "Generated files were not published completely. Regenerate the report files before downloading.";
  } else if (jobStatus === "error" || reportStatus === "error") {
    generationState = "error";
    resolvedJobStatus = jobStatus || "error";
  } else if (filesReady) {
    generationState = "ready";
    resolvedJobStatus = jobStatus || "done";
  } else if (reportStatus === "processing") {
    generationState = "processing";
    resolvedJobStatus = jobStatus || "processing";
  } else if (Boolean(report?.files_generating) || Boolean(report?.files_regenerating)) {
    generationState = "processing";
    resolvedJobStatus = jobStatus || "processing";
  } else if (["preview", "declined"].includes(reportStatus)) {
    // A preview is a successful terminal analysis state even though final files
    // may not exist until the user submits it.
    generationState = "ready";
    resolvedJobStatus = jobStatus || "done";
  } else {
    generationState = "error";
    resolvedJobStatus = jobStatus || "error";
    resolvedError = jobError || "Generated files are unavailable. Please retry file generation.";
  }

  const workflow = workflowForReport(report, generationState, filesReady, resolvedError);
  return {
    generation_state: generationState,
    files_ready: filesReady,
    job_status: resolvedJobStatus,
    ...(resolvedError ? { job_error: resolvedError } : {}),
    ...workflow,
  };
}

export function resolveReportGenerationState(
  report: any,
  ...visibleFileSources: any[]
): ReportStatePayload {
  return resolveReportGenerationStateWithReadiness(
    report,
    hasGeneratedReportFiles(...visibleFileSources)
  );
}

export function resolveReportGenerationStateForProfile(
  profile: ReportArtifactProfile,
  report: any,
  ...visibleFileSources: any[]
): ReportStatePayload {
  const state = resolveReportGenerationStateWithReadiness(
    report,
    hasRequiredReportFiles(profile, ...visibleFileSources)
  );
  return profile === "asset" || profile === "lotListing"
    ? { ...state, preview_available: hasSavedReportPreview(profile, report) }
    : state;
}

export function reportFilesGeneratingForPayload(
  report: any,
  ...visibleFileSources: any[]
): boolean {
  const state = resolveReportGenerationState(report, ...visibleFileSources).generation_state;
  return state === "queued" || state === "processing";
}

export function reportFilesRegeneratingForPayload(
  report: any,
  ...visibleFileSources: any[]
): boolean {
  return (
    Boolean(report?.files_regenerating) &&
    resolveReportGenerationState(report, ...visibleFileSources).generation_state === "processing"
  );
}

export function reportFilesGeneratingForProfile(
  profile: ReportArtifactProfile,
  report: any,
  ...visibleFileSources: any[]
): boolean {
  const state = resolveReportGenerationStateForProfile(
    profile,
    report,
    ...visibleFileSources
  ).generation_state;
  return state === "queued" || state === "processing";
}

export function reportFilesRegeneratingForProfile(
  profile: ReportArtifactProfile,
  report: any,
  ...visibleFileSources: any[]
): boolean {
  return (
    Boolean(report?.files_regenerating) &&
    resolveReportGenerationStateForProfile(
      profile,
      report,
      ...visibleFileSources
    ).generation_state === "processing"
  );
}
