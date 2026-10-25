import ReportDraft from "../models/reportDraft.model.js";

export type DraftPreviewStatus = "idle" | "queued" | "processing" | "ready" | "error";

type LifecyclePatch = {
  status: DraftPreviewStatus;
  error?: string;
  reportId?: string;
  processedRevision?: number;
};

/**
 * Updates a draft only when the finishing worker still owns the requested
 * revision/job. This prevents a late retry from replacing a newer draft preview.
 */
export async function updateDraftPreviewLifecycle(
  draftId: string,
  requestedRevision: number,
  jobId: string,
  patch: LifecyclePatch,
) {
  const now = new Date();
  const set: Record<string, unknown> = {
    previewStatus: patch.status,
    previewError: patch.error || undefined,
  };
  if (patch.reportId) set.previewReportId = patch.reportId;
  if (patch.processedRevision !== undefined) {
    set.previewProcessedRevision = patch.processedRevision;
  }
  if (patch.status === "ready") set.previewReadyAt = now;

  return ReportDraft.findOneAndUpdate(
    {
      _id: draftId,
      previewRequestedRevision: requestedRevision,
      previewJobId: jobId,
    },
    { $set: set },
    { new: true },
  );
}

