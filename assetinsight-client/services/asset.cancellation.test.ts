import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  apiPost: vi.fn(),
  uploadReportFilesDirectToR2: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  default: { post: mocks.apiPost },
}));

vi.mock("./directUpload", () => ({
  isUploadSessionUnsupportedError: (error: unknown) =>
    (error as { code?: string } | null)?.code ===
    "UPLOAD_SESSION_UNSUPPORTED",
  uploadReportFilesDirectToR2: mocks.uploadReportFilesDirectToR2,
}));

import { AssetService } from "./asset";

describe("AssetService upload cancellation", () => {
  beforeEach(() => {
    mocks.apiPost.mockReset();
    mocks.uploadReportFilesDirectToR2.mockReset();
  });

  it("transports every report image while leaving AI sampling to the server", async () => {
    mocks.uploadReportFilesDirectToR2.mockResolvedValueOnce({
      jobId: "job-all-images",
      reportId: "report-all-images",
      status: "processing",
    });
    const images = Array.from(
      { length: 12 },
      (_, index) =>
        new File([`photo-${index}`], `photo-${index}.jpg`, {
          type: "image/jpeg",
        })
    );

    await AssetService.create(
      {
        grouping_mode: "single_lot",
        client_submission_id: "asset-all-images",
      } as Parameters<typeof AssetService.create>[0],
      images
    );

    expect(mocks.uploadReportFilesDirectToR2).toHaveBeenCalledWith(
      expect.objectContaining({
        files: expect.arrayContaining(
          images.map((file, imageIndex) =>
            expect.objectContaining({ file, imageIndex })
          )
        ),
      })
    );
    expect(mocks.uploadReportFilesDirectToR2.mock.calls[0][0].files).toHaveLength(
      12
    );
    expect(mocks.apiPost).not.toHaveBeenCalled();
  });

  it("cancels the legacy multipart fallback after upload-session incompatibility", async () => {
    const controller = new AbortController();
    let fallbackSignal: AbortSignal | undefined;
    mocks.uploadReportFilesDirectToR2.mockRejectedValueOnce({
      code: "UPLOAD_SESSION_UNSUPPORTED",
    });
    mocks.apiPost.mockImplementation(
      (
        url: string,
        _body: FormData,
        config?: { signal?: AbortSignal }
      ) => {
        expect(url).toBe("/asset");
        fallbackSignal = config?.signal;
        return new Promise((_resolve, reject) => {
          const rejectAsAborted = () =>
            reject(
              fallbackSignal?.reason ||
                new DOMException("The operation was aborted", "AbortError")
            );
          if (fallbackSignal?.aborted) rejectAsAborted();
          else {
            fallbackSignal?.addEventListener("abort", rejectAsAborted, {
              once: true,
            });
          }
        });
      }
    );

    const creating = AssetService.create(
      {
        grouping_mode: "mixed",
        client_submission_id: "asset-fallback-cancel",
      } as Parameters<typeof AssetService.create>[0],
      [new File(["photo"], "asset-photo.jpg", { type: "image/jpeg" })],
      [],
      { signal: controller.signal }
    );

    await vi.waitFor(() => expect(mocks.apiPost).toHaveBeenCalledOnce());
    expect(fallbackSignal).toBe(controller.signal);

    controller.abort();

    await expect(creating).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.uploadReportFilesDirectToR2).toHaveBeenCalledOnce();
    expect(mocks.apiPost).toHaveBeenCalledOnce();
  });

  it("does not create a second legacy submission for a later session-file 404", async () => {
    const uploadError = { response: { status: 404 } };
    mocks.uploadReportFilesDirectToR2.mockRejectedValueOnce(uploadError);

    await expect(
      AssetService.create(
        {
          grouping_mode: "mixed",
          client_submission_id: "asset-session-file-failure",
        } as Parameters<typeof AssetService.create>[0],
        [new File(["photo"], "asset-photo.jpg", { type: "image/jpeg" })]
      )
    ).rejects.toBe(uploadError);

    expect(mocks.apiPost).not.toHaveBeenCalled();
  });
});
