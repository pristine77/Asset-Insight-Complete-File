type ReportFamily = { reportType?: string; isRealEstateReport?: boolean };

export function releasesWithApproval(report: ReportFamily): boolean {
  return Boolean(report.isRealEstateReport) || ["realestate", "salvage"].includes(String(report.reportType || "").toLowerCase().replace(/[\s_-]/g, ""));
}

export function pendingApprovalBlockReason(report: {
  files_generating?: boolean; files_regenerating?: boolean; files_ready?: boolean;
  generation_state?: string; workflow_stage?: string; job_status?: string;
}): string | null {
  if (report.files_generating || report.files_regenerating || ["queued", "processing"].includes(report.generation_state || "") || ["queued", "processing"].includes(report.job_status || "") || ["preparing_preview", "generating_files"].includes(report.workflow_stage || "")) {
    return "Files are being generated. Refresh when processing finishes before approving.";
  }
  if (report.files_ready === false || report.generation_state === "error" || report.workflow_stage === "error" || ["error", "failed"].includes(report.job_status || "")) {
    return "The current report files are incomplete. The creator must regenerate them before approval.";
  }
  return null;
}

export function groupPendingApprovalRows<T extends { _id: string; report?: string; createdAt: string; updatedAt?: string }>(items: T[]): (T & { actionId: string })[] {
  const grouped = new Map<string, T & { actionId: string }>();
  for (const item of items) {
    const groupId = String(item.report || item._id);
    const current = grouped.get(groupId);
    // PdfReport rows group by parent, but decisions/previews address an artifact
    // _id. Modern Asset/Real Estate preview rows already use the parent as _id.
    if (!current || new Date(item.updatedAt || item.createdAt).getTime() > new Date(current.updatedAt || current.createdAt).getTime()) {
      grouped.set(groupId, { ...item, actionId: item._id });
    }
  }
  return Array.from(grouped.values()).sort((a, b) => new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime());
}

export type SalvageReviewAcknowledgement = {
  baseRevision: number;
  limitationCodes: string[];
  note: string;
};
export type ReportApprovalRequest = { salvageReviewAcknowledgement?: SalvageReviewAcknowledgement };
export type SalvageApprovalReview = {
  baseRevision: number;
  limitations: Array<{ code: string; message: string }>;
  requiredLimitationCodes: string[];
};

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const validCode = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,120}$/.test(value);

/** Parse only the decision input; actor, date and final authority stay server-owned. */
export function parseReportApprovalRequest(value: unknown): ReportApprovalRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Approval details must be an object.");
  const raw = object(value).salvageReviewAcknowledgement;
  if (raw === undefined) return {};
  const input = object(raw);
  if (!Number.isSafeInteger(input.baseRevision) || Number(input.baseRevision) < 0) throw new Error("A valid reviewed revision is required.");
  if (!Array.isArray(input.limitationCodes) || input.limitationCodes.length > 200 || !input.limitationCodes.every(validCode)) {
    throw new Error("Invalid Salvage limitation acknowledgements.");
  }
  if (typeof input.note !== "string" || input.note.trim().length > 2000) throw new Error("The review note must be at most 2000 characters.");
  return { salvageReviewAcknowledgement: { baseRevision: Number(input.baseRevision),
    limitationCodes: [...new Set(input.limitationCodes)].sort(), note: input.note.trim() } };
}

/** Only a loaded, revisioned preview can establish the acknowledgement list. */
export function salvageApprovalReviewFromPreview(value: unknown): SalvageApprovalReview | null {
  const payload = object(value);
  if (!payload.data || typeof payload.data !== "object" || Array.isArray(payload.data)) throw new Error("The report preview is missing. Reload before approving.");
  const rawAssessment = object(payload.data).assessment;
  if (rawAssessment === undefined || rawAssessment === null) return null;
  const assessment = object(rawAssessment);
  if (assessment.schemaVersion !== 2 || !Number.isSafeInteger(payload.revision) || Number(payload.revision) < 0
    || !Array.isArray(assessment.limitations) || typeof assessment.stale !== "boolean") {
    throw new Error("The Salvage assessment could not be verified. Reload the latest report before approving.");
  }
  const limitations = new Map<string, string>();
  for (const entry of assessment.limitations) {
    const limitation = object(entry);
    if (typeof limitation.acknowledgementRequired !== "boolean") throw new Error("The assessment contains an invalid limitation. Reload before approving.");
    if (!limitation.acknowledgementRequired) continue;
    if (!validCode(limitation.code) || typeof limitation.message !== "string" || !limitation.message.trim()) {
      throw new Error("The assessment contains an incomplete limitation. Reload before approving.");
    }
    limitations.set(limitation.code, limitation.message);
  }
  const required = new Set(limitations.keys());
  if (assessment.stale) {
    required.add("research_stale");
    // Older server helpers record an additional lowercase stale marker. One
    // clearly worded checkbox acknowledges the same condition without duplicate UI.
    if (![...limitations.keys()].some(code => code.toLowerCase() === "research_stale")) {
      limitations.set("research_stale", "Material report inputs changed after research. The existing evidence selection is stale.");
    }
  }
  return { baseRevision: Number(payload.revision), limitations: [...limitations].map(([code, message]) => ({ code, message })),
    requiredLimitationCodes: [...required].sort() };
}

export function buildSalvageReviewAcknowledgement(review: SalvageApprovalReview | null, acceptedCodes: string[], note: string): SalvageReviewAcknowledgement | null {
  if (!review || note.trim().length > 2000) return null;
  const accepted = new Set(acceptedCodes);
  if (review.limitations.some(item => !accepted.has(item.code)) || (review.requiredLimitationCodes.length > 0 && !note.trim())) return null;
  return { baseRevision: review.baseRevision, limitationCodes: [...review.requiredLimitationCodes], note: note.trim() };
}
