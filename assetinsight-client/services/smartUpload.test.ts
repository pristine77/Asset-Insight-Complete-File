import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  completeSmartUpload,
  getSmartUploadCompletionStatus,
  getSmartUploadGrouping,
  isSmartUploadCompletionPending,
  recoverSmartUploadCompletion,
  updateSmartUploadDividers,
  createOrResumeSmartUploadSession,
  waitForSmartUploadGrouping,
} from "./smartUpload";
import type { SmartUploadDraft } from "@/components/forms/smartUpload/storage";

const api = vi.hoisted(() => ({ post: vi.fn(), get: vi.fn(), patch: vi.fn() }));
vi.mock("@/lib/api", () => ({ default: api }));

const accepted = { sessionId: "session-1", accepted: true, status: "queued", reportId: "report-1", jobId: "preview-1", message: "Preview queued", phase: "queued" };
const envelope = (data: unknown) => ({ data: { data } });
const responseError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { response: { status, data: { message: `HTTP ${status}` } } });

describe("Smart Upload completion recovery", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
  });
  afterEach(() => { vi.useRealTimers(); });

  it.each(["asset", "lot-listing"] as const)("recovers an ambiguous %s completion without posting a new upload", async (kind) => {
    api.post.mockRejectedValueOnce(Object.assign(new Error("timeout of 45000ms exceeded"), { code: "ECONNABORTED" }));
    api.get.mockResolvedValueOnce(envelope(accepted));
    await expect(completeSmartUpload(kind, "session-1")).resolves.toMatchObject({ reportId: "report-1", jobId: "preview-1" });
    expect(api.post).toHaveBeenCalledExactlyOnceWith(`/${kind}/upload-session/session-1/complete`, {}, { signal: undefined, timeout: 45_000 });
    expect(api.get).toHaveBeenCalledExactlyOnceWith(`/${kind}/upload-session/session-1/status`, { signal: undefined, timeout: 20_000 });
  });

  it("does not poll after an immediately accepted completion", async () => {
    api.post.mockResolvedValueOnce({ data: accepted });
    await expect(completeSmartUpload("asset", "session-1")).resolves.toMatchObject({ reportId: "report-1", jobId: "preview-1" });
    expect(api.get).not.toHaveBeenCalled();
  });

  it.each([502, 503, 504])("checks exact acceptance after HTTP %s", async (status) => {
    api.post.mockRejectedValueOnce(responseError(status));
    api.get.mockResolvedValueOnce(envelope(accepted));
    await expect(completeSmartUpload("asset", "session-1")).resolves.toMatchObject({ jobId: "preview-1" });
    expect(api.post).toHaveBeenCalledTimes(1);
  });

  it("finishes a preparing session with the same complete request", async () => {
    api.get.mockResolvedValueOnce(envelope({ sessionId: "session-1", accepted: false, status: "preparing", reportId: "placeholder", jobId: "classification-only" }));
    api.post.mockResolvedValueOnce({ data: accepted });
    await expect(recoverSmartUploadCompletion("asset", "session-1")).resolves.toMatchObject({ jobId: "preview-1" });
    expect(api.post).toHaveBeenCalledExactlyOnceWith("/asset/upload-session/session-1/complete", {}, { signal: undefined, timeout: 45_000 });
  });

  it("bounds status checks and handoff retries when the server is still preparing", async () => {
    api.get.mockResolvedValue(envelope({ sessionId: "session-1", accepted: false, status: "preparing" }));
    api.post.mockRejectedValue(responseError(503));
    const result = recoverSmartUploadCompletion("asset", "session-1").catch((error: unknown) => error);
    await vi.runAllTimersAsync();
    expect(isSmartUploadCompletionPending(await result)).toBe(true);
    expect(api.get).toHaveBeenCalledTimes(6);
    expect(api.post).toHaveBeenCalledTimes(2);
    expect(api.post.mock.calls.every((call) => call[0] === "/asset/upload-session/session-1/complete")).toBe(true);
  });

  it("does not mistake a placeholder report or classification job for acceptance", async () => {
    api.get.mockResolvedValueOnce(envelope({ ...accepted, accepted: false, status: "ready", jobId: "classification-only" }));
    const error = await recoverSmartUploadCompletion("asset", "session-1").catch((error: unknown) => error);
    expect(isSmartUploadCompletionPending(error)).toBe(true);
    expect((error as Error).message).toContain("Retry preview creation");
    expect(api.post).not.toHaveBeenCalled();
  });

  it.each([
    { ...accepted, sessionId: "another-session" },
    { ...accepted, accepted: "true" },
    { ...accepted, status: "classifying" },
  ])("rejects mismatched or malformed status %#", async (status) => {
    api.get.mockResolvedValueOnce(envelope(status));
    await expect(getSmartUploadCompletionStatus("asset", "session-1")).rejects.toMatchObject({ completionPending: true });
  });

  it("keeps recovery pending when acceptance lacks identifiers", async () => {
    api.get.mockResolvedValueOnce(envelope({ sessionId: "session-1", accepted: true, status: "queued" }));
    await expect(recoverSmartUploadCompletion("asset", "session-1")).rejects.toMatchObject({ completionPending: true });
    expect(api.post).not.toHaveBeenCalled();
  });

  it("checks status instead of accepting a malformed completion response", async () => {
    api.post.mockResolvedValueOnce({ data: { reportId: "placeholder" } });
    api.get.mockResolvedValueOnce(envelope(accepted));
    await expect(completeSmartUpload("asset", "session-1")).resolves.toMatchObject({ jobId: "preview-1" });
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  it("retains an actionable same-session recovery when the status route is not deployed", async () => {
    api.get.mockRejectedValueOnce(responseError(404));
    await expect(recoverSmartUploadCompletion("asset", "session-1")).rejects.toThrow("after the backend update; do not re-upload");
    expect(api.post).not.toHaveBeenCalled();
  });

  it("does not automatically retry definitive validation or permission failures", async () => {
    api.post.mockRejectedValueOnce(responseError(403));
    await expect(completeSmartUpload("asset", "session-1")).rejects.toMatchObject({ response: { status: 403 } });
    expect(api.get).not.toHaveBeenCalled();
    expect(api.post).toHaveBeenCalledTimes(1);
  });

  it.each(["offline", "hidden"])("pauses automatic recovery while %s", async (condition) => {
    if (condition === "offline") vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    else vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await expect(recoverSmartUploadCompletion("asset", "session-1")).rejects.toMatchObject({ completionPending: true });
    expect(api.get).not.toHaveBeenCalled();
    expect(api.post).not.toHaveBeenCalled();
  });

  it("cancels bounded backoff without a later status or handoff call", async () => {
    api.get.mockRejectedValue(responseError(504));
    const controller = new AbortController();
    const result = recoverSmartUploadCompletion("asset", "session-1", { signal: controller.signal }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await vi.runAllTimersAsync();
    expect(await result).toMatchObject({ name: "AbortError" });
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(api.post).not.toHaveBeenCalled();
  });

  it("ignores a late grouping response when the review window closes during a read", async () => {
    let resolve!: (value: unknown) => void;
    api.get.mockImplementation(() => new Promise((done) => { resolve = done; }));
    const controller = new AbortController();
    const onProgress = vi.fn();
    const result = waitForSmartUploadGrouping({ kind: "asset", sessionId: "session-1", signal: controller.signal, onProgress }).catch((error: unknown) => error);
    controller.abort();
    resolve(envelope({ groupingMethod: "lot_number", groupingStatus: "review_ready" }));
    expect(await result).toMatchObject({ name: "AbortError" });
    expect(onProgress).not.toHaveBeenCalled();
    expect(api.get).toHaveBeenCalledOnce();
    expect(api.post).not.toHaveBeenCalled();
  });

  it("uses scoped timeouts for grouping review reads and revision-checked confirmation", async () => {
    api.get.mockResolvedValue(envelope({}));
    api.patch.mockResolvedValue(envelope({}));
    await getSmartUploadGrouping("asset", "session-1");
    await updateSmartUploadDividers({ kind: "asset", sessionId: "session-1", revision: 7, dividerFileIds: ["divider-1"], groups: [["photo-1"], ["photo-2"]], confirm: true });
    expect(api.get).toHaveBeenCalledWith("/asset/upload-session/session-1/smart-grouping", { timeout: 20_000 });
    expect(api.patch).toHaveBeenCalledWith("/asset/upload-session/session-1/smart-grouping", expect.objectContaining({ revision: 7, confirm: true, groups: [["photo-1"], ["photo-2"]] }), { timeout: 45_000 });
  });

  it.each(["asset", "lot-listing"] as const)("creates %s numbered uploads with the persisted method and original order", async (kind) => {
    api.post.mockResolvedValue(envelope({ sessionId: "numbered", groupingMethod: "lot_number" }));
    const draft: SmartUploadDraft = { version: 1, scope: "owner:asset:stable", userId: "owner", stage: "selected", savedAt: "2026-09-27T12:00:00Z", kind, details: { smart_upload_grouping_method: "lot_number" }, clientSubmissionId: "stable", files: [{ fileId: "sign", originalOrder: 0, name: "2500.jpg", type: "image/jpeg", size: 20, lastModified: 0, uploaded: false }] };
    await createOrResumeSmartUploadSession(draft);
    expect(api.post).toHaveBeenCalledWith(`/${kind}/upload-session`, expect.objectContaining({ groupingMethod: "lot_number", details: expect.objectContaining({ client_submission_id: "stable" }), files: [expect.objectContaining({ fileId: "sign", originalOrder: 0, role: "main" })] }));
  });

  it("fails closed when an older backend does not confirm numbered support", async () => {
    api.post.mockResolvedValue(envelope({ sessionId: "legacy" }));
    await expect(createOrResumeSmartUploadSession({ kind: "asset", details: { smart_upload_grouping_method: "lot_number" }, files: [] } as unknown as SmartUploadDraft)).rejects.toThrow("does not support Lot Number Upload");
  });

  it("preserves numbered evidence and sends acknowledgement only when explicit", async () => {
    const data = { groupingMethod: "lot_number", groups: [{ fileIds: ["sign", "photo"], lotNumber: "02500A" }], lotStartFileIds: ["sign"], unresolvedLotNumberFileIds: ["photo"], metrics: [{ fileId: "sign", kind: "lot_start", lotNumber: "02500A" }] };
    api.get.mockResolvedValue(envelope(data));
    api.patch.mockResolvedValue(envelope(data));
    const value = await getSmartUploadGrouping("asset", "session-1");
    expect(value).toMatchObject(data);
    const args = { kind: "asset" as const, sessionId: "session-1", dividerFileIds: [], groups: data.groups, revision: 3 };
    await updateSmartUploadDividers(args);
    expect(api.patch.mock.calls[0][1]).not.toHaveProperty("acknowledgeLotNumberReview");
    await updateSmartUploadDividers({ ...args, confirm: true, acknowledgeLotNumberReview: true });
    expect(api.patch.mock.calls[1][1]).toMatchObject({ groups: data.groups, dividerFileIds: [], acknowledgeLotNumberReview: true, confirm: true });
  });

  it.each(["other_method", "", null, 12])("rejects an unknown grouping method %s instead of downgrading", async (groupingMethod) => {
    api.get.mockResolvedValue(envelope({ groupingMethod }));
    await expect(getSmartUploadGrouping("asset", "session-1")).rejects.toThrow("unsupported upload method");
  });
});
