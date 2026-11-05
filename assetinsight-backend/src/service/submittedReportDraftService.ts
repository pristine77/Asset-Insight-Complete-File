/**
 * A draft is kept until its report's preview is ready (owner, 2026-11-05).
 *
 * Before: the server draft was deleted the moment its upload was accepted.
 * Processing runs after that, so when it failed (e.g. "Duplicate lot number 1")
 * the user had no preview AND no draft — Colin Kostenuk's "Dustin Hawkins"
 * report, Nov 4.
 *
 * Now the life of a sent draft is:
 *   1. upload accepted   -> marked submissionStatus "processing" with the
 *                           report's id; hidden from the Drafts lists (the
 *                           report shows in Report previews meanwhile).
 *   2. preview ready     -> deleted, exactly as acceptance used to delete it.
 *   3. processing failed -> marked "failed" and shown again in Drafts with the
 *                           reason, so the work can be opened and checked.
 *   4. Retry queued      -> back to "processing" (hidden) until 2 or 3 again.
 *   5. report deleted    -> markers cleared: an ordinary draft again.
 * Any save by the user clears the markers too (reportDraft.controller upsert):
 * an edited draft is new work and is never deleted by its old report.
 *
 * The decision is always taken from the report itself (see reportOutcome), so
 * calling settle more than once, or from more than one place, is harmless.
 * Every write is best-effort for its caller: a draft problem must never fail
 * an accepted upload or a finished job.
 */
import ReportDraft from "../models/reportDraft.model.js";
import ReportUploadSession from "../models/reportUploadSession.model.js";
import AssetReport from "../models/asset.model.js";
import LotListing from "../models/lotListing.model.js";
import { getCanonicalLotListingPreview } from "../utils/reportPreviewAvailability.js";

type DraftType = "asset" | "lotListing";

// Same rules as reportDraftService's helpers, repeated here because that
// module imports this one for the client note.
const normalizeDraftClientId = (value: unknown) =>
  String(value || "").trim().replace(/[^a-zA-Z0-9._:-]/g, "-").slice(0, 160);
const sessionTypeToDraftType = (type: unknown): DraftType =>
  ["lotListing", "lot-listing"].includes(String(type)) ? "lotListing" : "asset";
type Outcome = "ready" | "failed" | "processing" | "missing";

const modelFor = (type: DraftType): any => (type === "asset" ? AssetReport : LotListing);
const text = (value: unknown) => String(value ?? "").trim();

/** Background cleanup must never consume a save or media change made after its read. */
export function submittedDraftSnapshotFilter(draft: any) {
  return Object.fromEntries(["_id", "user", "revision", "mediaRevision", "contentHash", "updatedAt", "submittedReportId", "submissionStatus"]
    .map(key => [key, draft[key] === undefined ? { $exists: false } : draft[key]]));
}

/** Marker fields, cleared together whenever a draft becomes ordinary work again. */
export const SUBMITTED_DRAFT_MARKERS_CLEARED = {
  submittedReportId: null,
  submittedReportType: null,
  submittedAt: null,
  submissionStatus: null,
  submissionError: null,
  submissionFailedAt: null,
} as const;

/**
 * What the report says about its preview. Only the report's own state is
 * trusted: a finished worker can still have left the report in error.
 */
export function reportOutcome(type: DraftType, report: any): Outcome {
  if (!report) return "missing";
  const preview = type === "asset" ? report.preview_data : getCanonicalLotListingPreview(report);
  const hasPreviewLots = preview != null && Array.isArray(preview.lots) && preview.lots.length > 0;
  if (["queued", "processing"].includes(report.job_status) || report.status === "processing") return "processing";
  // Stopped without a preview (error, cancelled, anything else): the kept
  // draft is the only editable copy, so it shows again.
  return hasPreviewLots ? "ready" : "failed";
}

function failureMessage(report: any): string {
  const message = text(report?.job_error || report?.error_message);
  return (message || "Report processing stopped before a preview was made.").slice(0, 1000);
}

/**
 * Step 1, called where acceptance used to delete the draft. A save made after
 * the upload was accepted is new work and is not marked (same cutoff rule the
 * old delete used).
 */
export async function markAcceptedReportDraftsSubmitted(input: {
  userId: unknown;
  type: unknown;
  clientSubmissionIds: unknown[];
  reportId: unknown;
  notUpdatedAfter: Date;
  draftSnapshot?: any;
}) {
  const type = sessionTypeToDraftType(input.type);
  const submissionIds = [...new Set(input.clientSubmissionIds.map(normalizeDraftClientId).filter(Boolean))];
  const reportId = text(input.reportId);
  if (!submissionIds.length || !/^[a-f\d]{24}$/i.test(reportId)) return;
  await ReportDraft.updateMany(
    {
      user: input.userId as any,
      type,
      // A website form's draft id and its upload's submission id differ (the
      // phone's can too); the draft keeps the submission id in its form data.
      $or: [
        { clientDraftId: { $in: submissionIds } },
        { "formData.clientSubmissionId": { $in: submissionIds } },
      ],
      promotedAt: null,
      promotionToken: null,
      updatedAt: { $lt: input.notUpdatedAfter },
      ...(input.draftSnapshot ? { $and: [submittedDraftSnapshotFilter(input.draftSnapshot)] } : {}),
    },
    {
      $set: {
        submittedReportId: reportId,
        submittedReportType: type,
        submittedAt: new Date(),
        submissionStatus: "processing",
        submissionError: null,
        submissionFailedAt: null,
      },
    },
    // Keep updatedAt as the user's own last save: the cutoff above and the
    // Drafts list's "Saved" time both read it.
    { timestamps: false },
  );
}

/**
 * A delete that reaches a draft whose upload is accepted but not yet
 * processed is the sending app tidying up (the website did that right after
 * acceptance, and stale tabs or old phone builds still may), not the user
 * discarding work: the user cannot see such a draft. Keep it and make sure it
 * is marked; true means "kept". The upload-session read also covers a delete
 * that overtakes the acceptance mark.
 */
export async function keepDraftOfAcceptedUpload(draft: any): Promise<boolean> {
  if (!draft) return false;
  if (draft.submittedReportId && draft.submissionStatus === "processing") return true;
  const submissionIds = [...new Set([draft.clientDraftId, draft.formData?.clientSubmissionId]
    .map(normalizeDraftClientId).filter(Boolean))];
  if (!submissionIds.length) return false;
  const session: any = await ReportUploadSession.findOne({
    user: draft.user,
    type: sessionTypeToDraftType(draft.type),
    clientSubmissionId: { $in: submissionIds },
    status: { $in: ["completed", "queued"] },
    reportId: { $type: "string", $ne: "" },
    cleanupStartedAt: { $exists: false },
  }).select("_id reportId uploadCompletedAt queuedAt").sort({ updatedAt: -1 }).lean();
  if (!session) return false;
  const acceptedAt = session.uploadCompletedAt || session.queuedAt;
  // Missing historical receipt timing or newer work is retained, never
  // reattached to an old report which could delete it on completion.
  if (!acceptedAt || !Number.isFinite(new Date(acceptedAt).getTime()) ||
      !draft.updatedAt || new Date(draft.updatedAt).getTime() >= new Date(acceptedAt).getTime()) return true;
  await markAcceptedReportDraftsSubmitted({
    userId: draft.user,
    type: draft.type,
    clientSubmissionIds: submissionIds,
    reportId: session.reportId,
    notUpdatedAfter: new Date(acceptedAt),
    draftSnapshot: draft,
  });
  return true;
}

async function deleteSettledDrafts(drafts: any[]) {
  for (const draft of drafts) {
    // Same deletion acceptance used to do, now once the preview exists. The
    // marker condition stops a draft the user saved again in between.
    const deleted = await ReportDraft.findOneAndDelete({
      ...submittedDraftSnapshotFilter(draft),
      promotedAt: null,
      promotionToken: null,
    });
    if (!deleted) continue;
    await Promise.all([
      AssetReport.deleteMany({ user: deleted.user, source_draft_id: deleted._id, is_draft_preview: true } as any),
      LotListing.deleteMany({ user: deleted.user, source_draft_id: deleted._id, is_draft_preview: true } as any),
    ]);
  }
}

/**
 * Steps 2-5 for every kept draft of one report. Called when a preview job
 * finishes or fails, when a Retry is queued, and by the Drafts list for
 * drafts whose state looks out of date.
 */
export async function settleSubmittedReportDrafts(input: {
  reportId: unknown;
  reportType: unknown;
  userId?: unknown;
}) {
  const reportId = text(input.reportId);
  if (!/^[a-f\d]{24}$/i.test(reportId)) return;
  const type = sessionTypeToDraftType(input.reportType);
  const drafts = await ReportDraft.find({
    ...(input.userId ? { user: input.userId as any } : {}),
    submittedReportId: reportId,
    promotedAt: null,
    promotionToken: null,
  }).select("_id user revision mediaRevision contentHash updatedAt submittedReportId submissionStatus").lean();
  if (!drafts.length) return;
  const report = await modelFor(type).findById(reportId)
    .select("status job_status job_error error_message preview_data lots").lean();
  const outcome = reportOutcome(type, report);
  const ids = drafts.map((draft: any) => draft._id);
  const guard = { _id: { $in: ids }, submittedReportId: reportId };
  if (outcome === "ready") return deleteSettledDrafts(drafts);
  if (outcome === "missing") {
    return ReportDraft.updateMany(guard, { $set: SUBMITTED_DRAFT_MARKERS_CLEARED }, { timestamps: false });
  }
  if (outcome === "failed") {
    const message = failureMessage(report);
    // Only a change is written, so repeated settles cost a read, not a write.
    return ReportDraft.updateMany(
      { ...guard, $or: [{ submissionStatus: { $ne: "failed" } }, { submissionError: { $ne: message } }] },
      { $set: { submissionStatus: "failed", submissionError: message, submissionFailedAt: new Date() } },
      { timestamps: false },
    );
  }
  return ReportDraft.updateMany({ ...guard, submissionStatus: { $ne: "processing" } },
    { $set: { submissionStatus: "processing", submissionError: null, submissionFailedAt: null } },
    { timestamps: false });
}

/** Never lets a draft problem reach the caller (an upload, a job, a Retry). */
export function settleSubmittedReportDraftsBestEffort(input: Parameters<typeof settleSubmittedReportDrafts>[0]) {
  return settleSubmittedReportDrafts(input).catch((error) => {
    console.error("[SubmittedDraft] settle failed", {
      reportId: text(input.reportId),
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

/**
 * The Drafts list: drafts still being processed are hidden; failed ones are
 * shown with a `submission` note. Their reports are read in one small batch
 * per type, so a lost job notification can't hide a draft for good.
 */
export async function visibleReportDrafts<T extends { [key: string]: any }>(
  drafts: T[],
  reload: (ids: unknown[]) => Promise<T[]>,
): Promise<T[]> {
  const sent = drafts.filter((draft) => draft.submittedReportId);
  if (!sent.length) return drafts;
  // One small read per report type: just enough to see whether each kept
  // draft's marker still matches its report.
  const stateByReport = new Map<string, "processing" | "failed" | "other" | "missing">();
  for (const type of ["asset", "lotListing"] as const) {
    const ids = [...new Set(sent.filter((draft) => sessionTypeToDraftType(draft.submittedReportType || draft.type) === type)
      .map((draft) => text(draft.submittedReportId)))];
    if (!ids.length) continue;
    const reports = await modelFor(type).find({ _id: { $in: ids } }).select("_id status job_status").lean();
    const found = new Map(reports.map((report: any) => [text(report._id), report]));
    for (const id of ids) {
      const report: any = found.get(id);
      stateByReport.set(id, !report ? "missing"
        : ["queued", "processing"].includes(report.job_status) || report.status === "processing" ? "processing"
        : report.status === "error" || report.job_status === "error" ? "failed"
        : "other");
    }
  }
  // Out of date = a lost job notification, a Retry, a deleted report, or a
  // preview that is ready. Settle those, then read them again.
  const stale = new Map<string, { reportId: string; reportType: string }>();
  for (const draft of sent) {
    const id = text(draft.submittedReportId);
    const state = stateByReport.get(id);
    const upToDate = (state === "processing" && draft.submissionStatus === "processing") ||
      (state === "failed" && draft.submissionStatus === "failed");
    if (!upToDate) stale.set(id, { reportId: id, reportType: draft.submittedReportType || draft.type });
  }
  let current = drafts;
  if (stale.size) {
    // Bounded: a user only ever has a handful of recently sent drafts.
    await Promise.all([...stale.values()].slice(0, 20).map(settleSubmittedReportDraftsBestEffort));
    const staleDraftIds = sent.filter((draft) => stale.has(text(draft.submittedReportId))).map((draft) => draft._id);
    const fresh = new Map((await reload(staleDraftIds)).map((draft) => [text(draft._id), draft]));
    current = drafts.flatMap((draft) => {
      if (!stale.has(text(draft.submittedReportId))) return [draft];
      const next = fresh.get(text(draft._id));
      return next ? [next] : [];
    });
  }
  return current.filter((draft) => draft.submissionStatus !== "processing");
}

/** The client-facing note on a kept draft; internal fields are not exposed. */
export function submittedDraftClientValue(raw: any) {
  if (!raw?.submittedReportId || raw.submissionStatus !== "failed") return undefined;
  return {
    status: "failed" as const,
    reportId: text(raw.submittedReportId),
    reportType: raw.submittedReportType || raw.type,
    message: text(raw.submissionError) || "Report processing stopped before a preview was made.",
    sentAt: raw.submittedAt || null,
    failedAt: raw.submissionFailedAt || null,
  };
}
