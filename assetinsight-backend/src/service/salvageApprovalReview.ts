import type { SalvageAssessmentV2 } from "./salvageAssessment.js";

export interface SalvageReviewAcknowledgement {
  revision: number;
  limitation_codes: string[];
  note: string;
  reviewed_by: unknown;
  reviewed_at: Date;
}

/** This audit belongs to the approved artifact generation, never to a PDF signature. */
export function salvageApprovalAcknowledgement(
  parent: { revision?: number; preview_data?: Record<string, unknown> } | null,
  raw: unknown,
  reviewerId: unknown,
  now = new Date(),
): SalvageReviewAcknowledgement | undefined {
  const assessment = parent?.preview_data?.assessment as SalvageAssessmentV2 | undefined;
  if (assessment?.schemaVersion !== 2) return undefined;
  const required = [...new Set([
    ...(assessment.limitations || []).filter((item) => item.acknowledgementRequired).map((item) => item.code),
    ...(assessment.stale ? ["research_stale"] : []),
  ])].sort();
  if (!required.length && raw === undefined) return undefined;
  const input = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown> : {};
  const fail = (message: string): never => {
    throw Object.assign(new Error(message), {
      statusCode: 409, code: "SALVAGE_REVIEW_ACKNOWLEDGEMENT_REQUIRED",
      requiredLimitationCodes: required,
    });
  };
  if (!Number.isInteger(input.baseRevision) || input.baseRevision !== parent?.revision) {
    fail("Review the current Salvage revision and acknowledge its evidence limitations before approval.");
  }
  if (!required.length) return undefined;
  const codes = Array.isArray(input.limitationCodes) && input.limitationCodes.every((item) => typeof item === "string")
    ? [...new Set(input.limitationCodes as string[])].sort() : [];
  if (codes.length !== required.length || required.some((code, index) => codes[index] !== code)) {
    fail("Acknowledge every current evidence limitation before approving this Salvage report.");
  }
  const note = typeof input.note === "string" ? input.note.trim() : "";
  if ((required.length > 0 && !note) || note.length > 2000) {
    fail("Add a review note of 1–2000 characters explaining acceptance of the remaining limitations.");
  }
  return { revision: Number(parent?.revision), limitation_codes: required, note,
    reviewed_by: reviewerId, reviewed_at: now };
}
