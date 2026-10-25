import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock("@/lib/api", () => ({ default: { post: mocks.post } }));

import { AssetService } from "./asset";
import { createLotListing } from "./lotListing";
import { uploadFileThroughServerFallback, uploadFileToReportSession, uploadReportFilesDirectToR2 } from "./directUpload";
import { assertReportUploadAccepted, reportTransferErrorMessage } from "./reportTransferErrors";
import { advanceAuthSession } from "@/lib/auth-storage";

const accepted = { reportId: "report-1", jobId: "job-1", status: "processing" };
const readySession = { data: { sessionId: "session-1", jobId: "job-1", readyToComplete: true, files: [] } };
const file = (name: string) => new File([`original-${name}`], name, {
  type: name.endsWith("mp4") ? "video/mp4" : "image/jpeg", lastModified: 1_725_000_123_456,
});
function pending<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const creators = {
  asset: (progress: (fraction: number) => void, signal?: AbortSignal) => AssetService.create(
    { grouping_mode: "single_lot", progress_id: "original-identity" }, [file("main.jpg")], [],
    { onUploadProgress: progress, signal }
  ),
  "lot-listing": (progress: (fraction: number) => void, signal?: AbortSignal) => createLotListing(
    { client_submission_id: "original-identity" }, [{ files: [file("main.jpg")] }],
    { onUploadProgress: progress, signal }
  ),
};

beforeEach(() => { mocks.post.mockReset(); });
afterEach(() => { vi.useRealTimers(); });

describe("upload acceptance transport boundaries", () => {
  it.each(["/asset", "/lot-listing"] as const)("keeps %s at 95%% until a final receipt arrives", async (endpoint) => {
    const completion = pending<{ data: typeof accepted }>();
    mocks.post.mockResolvedValueOnce({ data: readySession }).mockReturnValueOnce(completion.promise);
    const progress = vi.fn();
    const result = uploadReportFilesDirectToR2({ endpoint, details: {}, files: [], onUploadProgress: progress });
    await vi.waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(2));
    expect(progress.mock.calls).toEqual([[0.95]]);
    completion.resolve({ data: accepted });
    await expect(result).resolves.toEqual(accepted);
    expect(progress.mock.calls).toEqual([[0.95], [1]]);
  });

  it.each([
    { ...accepted, accepted: false },
    { data: { ...accepted, accepted: false } },
    { accepted: false, data: { ...accepted, accepted: true } },
    { reportAvailable: false, data: { ...accepted, accepted: true } },
    { ...accepted, status: "uploading" },
    { reportId: "report-1" },
  ])("never emits completion for an unconfirmed session receipt %j", async (receipt) => {
    mocks.post.mockResolvedValueOnce({ data: readySession }).mockResolvedValueOnce({ data: receipt });
    const progress = vi.fn();
    await expect(uploadReportFilesDirectToR2({ endpoint: "/asset", details: {}, files: [], onUploadProgress: progress }))
      .rejects.toThrow("did not confirm report acceptance");
    expect(progress.mock.calls).toEqual([[0.95]]);
  });

  it("retains the reused-acceptance marker without reuploading files", async () => {
    mocks.post.mockResolvedValueOnce({ data: { data: { ...accepted, alreadyQueued: true, files: [] } } });
    const result = await uploadReportFilesDirectToR2({ endpoint: "/asset", details: {}, files: [] });
    expect(result).toMatchObject({ ...accepted, reusedAcceptance: true, resumed: true });
    expect(mocks.post).toHaveBeenCalledTimes(1);
  });

  it("rejects explicitly unaccepted alreadyQueued replies", async () => {
    mocks.post.mockResolvedValueOnce({ data: { data: { ...accepted, accepted: false, alreadyQueued: true, files: [] } } });
    const progress = vi.fn();
    await expect(uploadReportFilesDirectToR2({ endpoint: "/lot-listing", details: {}, files: [], onUploadProgress: progress }))
      .rejects.toThrow("did not confirm report acceptance");
    expect(progress).not.toHaveBeenCalled();
  });

  it.each([{ accepted: false }, { reportAvailable: false }])("honors outer denial on an already queued receipt %j", async (denial) => {
    mocks.post.mockResolvedValueOnce({ data: { ...denial, data: { ...accepted, accepted: true, alreadyQueued: true, files: [] } } });
    const progress = vi.fn();
    await expect(uploadReportFilesDirectToR2({ endpoint: "/asset", details: {}, files: [], onUploadProgress: progress }))
      .rejects.toThrow("did not confirm report acceptance");
    expect(progress).not.toHaveBeenCalled();
    expect(mocks.post).toHaveBeenCalledOnce();
  });

  it("retains explicit accepted proof for old receipts without a job ID", async () => {
    mocks.post.mockResolvedValueOnce({ data: { data: { reportId: "older-report", accepted: true, alreadyQueued: true, status: "processed", files: [] } } });
    const result = await uploadReportFilesDirectToR2({ endpoint: "/asset", details: {}, files: [] });
    expect(result).toMatchObject({ reportId: "older-report", accepted: true, reusedAcceptance: true });
    expect(() => assertReportUploadAccepted(result)).not.toThrow();
  });

  it.each(["create", "complete"] as const)("ignores late %s receipts after cancellation", async (stage) => {
    const controller = new AbortController();
    const reply = pending<unknown>();
    if (stage === "complete") mocks.post.mockResolvedValueOnce({ data: readySession });
    mocks.post.mockReturnValueOnce(reply.promise);
    const progress = vi.fn();
    const result = uploadReportFilesDirectToR2({ endpoint: "/asset", details: {}, files: [], signal: controller.signal, onUploadProgress: progress });
    await vi.waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(stage === "complete" ? 2 : 1));
    controller.abort();
    reply.resolve(stage === "complete" ? { data: accepted } : { data: { data: { ...accepted, alreadyQueued: true, files: [] } } });
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(progress.mock.calls.some(([fraction]) => fraction === 1)).toBe(false);
  });

  it.each(["create", "complete"] as const)("ignores late %s receipts after a silent session replacement", async (stage) => {
    const reply = pending<unknown>();
    if (stage === "complete") mocks.post.mockResolvedValueOnce({ data: readySession });
    mocks.post.mockReturnValueOnce(reply.promise);
    const progress = vi.fn();
    const result = uploadReportFilesDirectToR2({ endpoint: "/asset", details: {}, files: [], onUploadProgress: progress });
    await vi.waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(stage === "complete" ? 2 : 1));
    advanceAuthSession();
    reply.resolve(stage === "complete" ? { data: accepted } : { data: { data: { ...accepted, alreadyQueued: true, files: [] } } });
    await expect(result).rejects.toMatchObject({ name: "CanceledError" });
    expect(mocks.post).toHaveBeenCalledTimes(stage === "complete" ? 2 : 1);
    expect(progress.mock.calls.some(([fraction]) => fraction === 1)).toBe(false);
  });

  it("does not retry completion under a replacement session", async () => {
    vi.useFakeTimers();
    mocks.post.mockResolvedValueOnce({ data: readySession }).mockRejectedValueOnce(new Error("Network Error"));
    const result = uploadReportFilesDirectToR2({ endpoint: "/asset", details: {}, files: [] });
    const rejected = expect(result).rejects.toMatchObject({ name: "CanceledError" });
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.post).toHaveBeenCalledTimes(2);
    advanceAuthSession();
    await vi.advanceTimersByTimeAsync(1000);
    await rejected;
    expect(mocks.post).toHaveBeenCalledTimes(2);
  });

  it("does not start a serialized fallback slot under a replacement session", async () => {
    const firstReply = pending<unknown>();
    mocks.post.mockReturnValueOnce(firstReply.promise);
    const first = uploadFileThroughServerFallback("/asset", "session-1", "images-0", file("a.jpg"));
    const firstRejected = expect(first).rejects.toMatchObject({ name: "CanceledError" });
    const next = uploadFileThroughServerFallback("/asset", "session-1", "images-1", file("b.jpg"));
    const nextRejected = expect(next).rejects.toMatchObject({ name: "CanceledError" });
    await vi.waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(1));
    advanceAuthSession();
    firstReply.resolve({ data: {} });
    await Promise.all([firstRejected, nextRejected]);
    expect(mocks.post).toHaveBeenCalledTimes(1);
  });

  it("stops direct PUT callbacks and does not verify/fallback under a replacement session", async () => {
    const OriginalXHR = globalThis.XMLHttpRequest;
    class LateXHR {
      static latest: LateXHR;
      upload: { onprogress?: (event: unknown) => void } = {};
      status = 200;
      onload?: () => void;
      onabort?: () => void;
      constructor() { LateXHR.latest = this; }
      open() {}
      setRequestHeader() {}
      send() {}
      abort = vi.fn(() => this.onabort?.());
    }
    globalThis.XMLHttpRequest = LateXHR as unknown as typeof XMLHttpRequest;
    try {
      const progress = vi.fn();
      const result = uploadFileToReportSession({ endpoint: "/asset", sessionId: "session-1", fileId: "images-0", uploadUrl: "https://upload.example.test/file", file: file("a.jpg"), contentType: "image/jpeg", onDelta: progress });
      const xhr = LateXHR.latest;
      advanceAuthSession();
      xhr.upload.onprogress?.({ loaded: 5, lengthComputable: true });
      xhr.onload?.();
      await expect(result).rejects.toMatchObject({ name: "CanceledError" });
      expect(xhr.abort).toHaveBeenCalledOnce();
      expect(progress).not.toHaveBeenCalled();
      expect(mocks.post).not.toHaveBeenCalled();
    } finally { globalThis.XMLHttpRequest = OriginalXHR; }
  });
});

describe.each(Object.entries(creators))("%s legacy fallback", (kind, create) => {
  function unavailable() { mocks.post.mockRejectedValueOnce({ response: { status: 405 } }); }

  it("reports sending bytes separately from confirmed acceptance", async () => {
    unavailable();
    const response = pending<{ data: typeof accepted }>();
    const progress = vi.fn();
    mocks.post.mockImplementationOnce((_url, _body, options) => {
      options.onUploadProgress({ loaded: 10, total: 10, progress: 1 });
      return response.promise;
    });
    const result = create(progress);
    await vi.waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(2));
    expect(progress.mock.calls).toEqual([[0.95]]);
    response.resolve({ data: accepted });
    await expect(result).resolves.toEqual(accepted);
    expect(progress.mock.calls).toEqual([[0.95], [1]]);
    expect(mocks.post.mock.calls[1][0]).toBe(`/${kind}`);
  });

  it.each([{ ...accepted, accepted: false }, { data: { ...accepted, accepted: false } }, { accepted: false, data: { ...accepted, accepted: true } }, { reportAvailable: false, data: { ...accepted, accepted: true } }, { reportId: "placeholder" }])("rejects unaccepted legacy receipt %j", async (receipt) => {
    unavailable();
    mocks.post.mockResolvedValueOnce({ data: receipt });
    const progress = vi.fn();
    await expect(create(progress)).rejects.toThrow("did not confirm report acceptance");
    expect(progress).not.toHaveBeenCalledWith(1);
  });

  it("ignores late acceptance and progress after the owner cancels", async () => {
    unavailable();
    const response = pending<{ data: typeof accepted }>();
    const controller = new AbortController();
    let lateProgress!: (event: { loaded: number; total: number }) => void;
    mocks.post.mockImplementationOnce((_url, _body, options) => {
      expect(options.signal).toBe(controller.signal);
      lateProgress = options.onUploadProgress;
      return response.promise;
    });
    const progress = vi.fn();
    const result = create(progress, controller.signal);
    await vi.waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(2));
    controller.abort();
    lateProgress({ loaded: 10, total: 10 });
    response.resolve({ data: accepted });
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(progress).not.toHaveBeenCalled();
  });

  it("retains conflicts for safe caller guidance without a second submission", async () => {
    const error = { message: "Request failed with status code 409", response: { status: 409 } };
    mocks.post.mockRejectedValueOnce(error);
    await expect(create(vi.fn())).rejects.toBe(error);
    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(reportTransferErrorMessage(error, "submit")).toMatch(/conflicts with saved work/);
    expect(reportTransferErrorMessage(error, "submit")).not.toMatch(/409|status code/);
  });

  it("does not start legacy fallback after the session changes", async () => {
    const response = pending<never>();
    mocks.post.mockReturnValueOnce(response.promise);
    const result = create(vi.fn());
    advanceAuthSession();
    // A capability-shaped late error must not authorize a new-account upload.
    response.reject({ response: { status: 405 } });
    await expect(result).rejects.toMatchObject({ name: "CanceledError" });
    expect(mocks.post).toHaveBeenCalledTimes(1);
  });

  it("ignores legacy acceptance after a silent same-owner session change", async () => {
    unavailable();
    const response = pending<{ data: typeof accepted }>();
    const progress = vi.fn();
    let lateProgress!: (event: { loaded: number; total: number }) => void;
    mocks.post.mockImplementationOnce((_url, _body, options) => {
      lateProgress = options.onUploadProgress;
      return response.promise;
    });
    const result = create(progress);
    await vi.waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(2));
    advanceAuthSession();
    lateProgress({ loaded: 10, total: 10 });
    response.resolve({ data: accepted });
    await expect(result).rejects.toMatchObject({ name: "CanceledError" });
    expect(progress).not.toHaveBeenCalled();
  });
});

describe("Lot Listing helper manifest parity", () => {
  const lots = [
    { files: [file("a.jpg"), file("b.jpg")], extraFiles: [file("extra.jpg")], videoFiles: [file("a.mp4")] },
    { files: [file("c.jpg")], extraFiles: [], videoFiles: [file("b.mp4")] },
  ];
  const details = { client_submission_id: "fixed-identity", lots: [{ count: 2, extra_count: 1, video_count: 1 }, { count: 1, extra_count: 0, video_count: 1 }] };

  it("preserves interleaved lot/role slots, metadata and byte identity", async () => {
    mocks.post.mockResolvedValueOnce({ data: { data: { ...accepted, alreadyQueued: true, files: [] } } });
    await createLotListing(details, lots);
    const sent = mocks.post.mock.calls[0][1];
    expect(sent.details).toBe(details);
    expect(sent.files.map(({ fileId, name, role, lotIndex, imageIndex }: Record<string, unknown>) => [fileId, name, role, lotIndex, imageIndex])).toEqual([
      ["images-0", "a.jpg", "main", 0, 0], ["images-1", "b.jpg", "main", 0, 1],
      ["images-2", "extra.jpg", "extra", 0, 0], ["videos-3", "a.mp4", "video", 0, 0],
      ["images-4", "c.jpg", "main", 1, 0], ["videos-5", "b.mp4", "video", 1, 0],
    ]);
    expect(sent.files.every((entry: Record<string, unknown>) => entry.lastModified === 1_725_000_123_456 && Number(entry.size) > 0)).toBe(true);
  });

  it("uses original ordered File objects in the fallback without rewriting metadata", async () => {
    mocks.post.mockRejectedValueOnce({ response: { status: 405 } }).mockResolvedValueOnce({ data: accepted });
    await createLotListing(details, lots);
    const body = mocks.post.mock.calls[1][1] as FormData;
    expect(body.getAll("images")).toEqual([lots[0].files[0], lots[0].files[1], lots[0].extraFiles[0], lots[1].files[0]]);
    expect(body.getAll("videos")).toEqual([lots[0].videoFiles[0], lots[1].videoFiles[0]]);
    expect(JSON.parse(String(body.get("details")))).toEqual(details);
  });
});
