import { captureAuthSession, assertAuthSessionCurrent } from "@/lib/auth-storage";
import { loadScopedDraft, saveScopedDraft, type ScopedDraftEnvelope } from "@/components/forms/drafts/storage";
import { loadResumableDraft, type UploadResumeRecord } from "./uploadResumeStore";
import { navigateToReportForm } from "./reportFormNavigation";

export type UploadReviewIdentity = {
  submissionActivityId?: string;
  forceNewSubmission?: boolean;
  supersededSubmissionId?: string;
};

export function isUploadReviewScope(scopeId?: string): boolean {
  return Boolean(scopeId?.startsWith("upload-review:"));
}

/** Explicit review never overwrites the user's current draft or the frozen upload. */
export async function openUploadForReview(
  record: UploadResumeRecord,
  router: { push: (href: string) => void },
  isCurrent: () => boolean,
): Promise<void> {
  const session = captureAuthSession();
  const check = () => {
    assertAuthSessionCurrent(session);
    if (!isCurrent()) throw new Error("The account changed. Open this upload again from its original account.");
    if (typeof window !== "undefined" && /^\/create\//.test(window.location.pathname)) {
      throw new Error("Save or close your current form before reviewing this saved upload. Its original report and media are kept.");
    }
  };
  check();
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  // Web Locks serialize creation across tabs. Without them, a new isolated
  // scope is safer than racing an existing editable copy.
  const scopeId = `upload-review:${record.clientSubmissionId}${locks ? "" : `:${crypto.randomUUID()}`}`;
  const open = async () => {
  check();
  const existing = await loadScopedDraft(record.ownerId, record.kind, scopeId);
  check();
  if (existing) {
    const envelope = existing.envelope as ScopedDraftEnvelope & { formData?: { clientSubmissionId?: string }; data?: { clientSubmissionId?: string } };
    const fields = record.kind === "asset" ? envelope.formData : envelope.data;
    if (existing.missingMediaCount || fields?.clientSubmissionId !== record.clientSubmissionId) {
      throw new Error("The existing review draft needs attention. Open it from Drafts; your original upload is retained and has not been overwritten.");
    }
  }
  // Reopening review preserves any edits already made to that separate copy.
  if (!existing) {
    const loaded = await loadResumableDraft(record, { isCurrent });
    check();
    if (!loaded) throw new Error("The saved upload is unavailable on this browser. Check Reports before creating another submission.");
    const source = loaded.envelope as ScopedDraftEnvelope & { formData?: object; data?: object };
    const identity: UploadReviewIdentity = {
      submissionActivityId: typeof loaded.record.details.activity_id === "string" ? loaded.record.details.activity_id : record.scopeId,
      forceNewSubmission: loaded.record.details.force_new === true,
      supersededSubmissionId: typeof loaded.record.details.supersedes_client_submission_id === "string" ? loaded.record.details.supersedes_client_submission_id : undefined,
    };
    const fields = { ...identity, clientSubmissionId: record.clientSubmissionId };
    const envelope = record.kind === "asset"
      ? { ...source, formData: { ...source.formData, ...fields } }
      : { ...source, data: { ...source.data, ...fields } };
    await saveScopedDraft(envelope, scopeId);
    check();
    const verified = await loadScopedDraft(record.ownerId, record.kind, scopeId);
    check();
    if (!verified || verified.missingMediaCount) throw new Error("The review copy could not be saved completely. Your original upload is retained; free browser storage and retry.");
  }
  navigateToReportForm(router, { kind: record.kind, resumeLocalDraftScopeId: scopeId, returnTo: "/dashboard" });
  };
  if (locks) await locks.request(`cv:upload-review:${record.key}`, open);
  else await open();
}
