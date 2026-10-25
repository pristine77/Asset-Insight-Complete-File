import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { advanceAuthSession } from "@/lib/auth-storage";
import { openUploadForReview, isUploadReviewScope } from "./uploadReviewNavigation";
import type { UploadResumeRecord } from "./uploadResumeStore";

const mocks = vi.hoisted(() => ({ load: vi.fn(), save: vi.fn(), immutable: vi.fn(), navigate: vi.fn() }));
vi.mock("@/components/forms/drafts/storage", () => ({ loadScopedDraft: mocks.load, saveScopedDraft: mocks.save }));
vi.mock("./uploadResumeStore", () => ({ loadResumableDraft: mocks.immutable }));
vi.mock("./reportFormNavigation", () => ({ navigateToReportForm: mocks.navigate }));

const router = { push: vi.fn() };
const base: UploadResumeRecord = { version: 2, key: "original-key", kind: "asset", ownerId: "owner", scopeId: "original-activity", endpoint: "/asset", clientSubmissionId: "original-submit", title: "Asset", totalFiles: 1, uploadedFiles: 0, files: [], savedAt: "2026-10-15", details: { activity_id: "original-activity", force_new: true, supersedes_client_submission_id: "previous-submit" }, needsForm: true };
beforeEach(() => {
  window.history.replaceState({}, "", "/dashboard");
  vi.clearAllMocks();
  Object.defineProperty(navigator, "locks", { configurable: true, value: { request: vi.fn(async (_key, callback) => callback()) } });
  mocks.save.mockResolvedValue(undefined);
});
afterEach(() => Object.defineProperty(navigator, "locks", { configurable: true, value: undefined }));

describe("explicit immutable upload review", () => {
  it("does not replace an open form or leave a stale same-route handoff", async () => {
    window.history.replaceState({}, "", "/create/asset");
    await expect(openUploadForReview(base, router, () => true)).rejects.toThrow(/Save or close your current form/);
    expect(mocks.load).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });
  it.each(["asset", "lot-listing"] as const)("copies %s into a separate review scope with original submission/activity authority", async (kind) => {
    const record = { ...base, kind, endpoint: kind === "asset" ? "/asset" as const : "/lot-listing" as const };
    const fields = { clientSubmissionId: "original-submit", contractNo: "123", lots: [{ files: [new File(["original"], "photo.jpg")] }] };
    const envelope = { version: 3, kind, userId: "owner", revision: 4, savedAt: "2026-10-15", ...(kind === "asset" ? { formData: fields, lots: fields.lots } : { data: fields }) };
    mocks.load.mockResolvedValueOnce(null).mockResolvedValueOnce({ envelope, missingMediaCount: 0 });
    mocks.immutable.mockResolvedValue({ record, envelope, media: fields.lots[0].files });
    await openUploadForReview(record, router, () => true);
    const [copy, scope] = mocks.save.mock.calls[0];
    expect(scope).toBe("upload-review:original-submit");
    expect(scope).not.toBe(record.scopeId);
    expect(kind === "asset" ? copy.formData : copy.data).toMatchObject({ contractNo: "123", clientSubmissionId: "original-submit", submissionActivityId: "original-activity", forceNewSubmission: true, supersededSubmissionId: "previous-submit" });
    expect(mocks.navigate).toHaveBeenCalledWith(router, { kind, resumeLocalDraftScopeId: scope, returnTo: "/dashboard" });
    expect(isUploadReviewScope(scope)).toBe(true);
  });
  it("opens existing review edits without overwriting them or re-reading originals", async () => {
    mocks.load.mockResolvedValue({ envelope: { formData: { clientSubmissionId: "original-submit", contractNo: "edited" } }, missingMediaCount: 0 });
    await openUploadForReview(base, router, () => true);
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.immutable).not.toHaveBeenCalled();
    expect(mocks.navigate).toHaveBeenCalledOnce();
  });
  it.each([1, 0])("does not overwrite incomplete or mismatched existing review drafts (%s)", async (missingMediaCount) => {
    mocks.load.mockResolvedValue({ envelope: { formData: { clientSubmissionId: missingMediaCount ? "original-submit" : "changed-submit" } }, missingMediaCount });
    await expect(openUploadForReview(base, router, () => true)).rejects.toThrow(/existing review draft/);
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });
  it("does not navigate or copy after an account change during read", async () => {
    mocks.load.mockImplementation(async () => { advanceAuthSession(); return null; });
    await expect(openUploadForReview(base, router, () => true)).rejects.toThrow(/session changed/);
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });
  it("leaves the original untouched when review storage fails", async () => {
    mocks.load.mockResolvedValue(null);
    mocks.immutable.mockResolvedValue({ record: base, envelope: { version: 3, userId: "owner", kind: "asset", formData: {}, lots: [] } });
    mocks.save.mockRejectedValue(new DOMException("Storage full", "QuotaExceededError"));
    await expect(openUploadForReview(base, router, () => true)).rejects.toThrow();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });
  it("uses isolated scopes when cross-tab locks are unavailable", async () => {
    Object.defineProperty(navigator, "locks", { configurable: true, value: undefined });
    mocks.load.mockResolvedValue({ envelope: { formData: { clientSubmissionId: "original-submit" } }, missingMediaCount: 0 });
    await Promise.all([openUploadForReview(base, router, () => true), openUploadForReview(base, router, () => true)]);
    const scopes = mocks.navigate.mock.calls.map(([, handoff]) => handoff.resumeLocalDraftScopeId);
    expect(scopes[0]).not.toBe(scopes[1]);
    expect(scopes.every(isUploadReviewScope)).toBe(true);
  });
});
